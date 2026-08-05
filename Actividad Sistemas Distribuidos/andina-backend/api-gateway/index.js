const express = require('express');
const cors = require('cors');
const { log } = require('../shared/logger');

const SERVICE = 'api-gateway';
const PORT = process.env.PORT || 4000;
const INSTANCE_ID = process.env.INSTANCE_ID || 'A';

const SEARCH_URL = process.env.SEARCH_URL || 'http://localhost:4001';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:4002';
const BOOKING_URL = process.env.BOOKING_URL || 'http://localhost:4003';
const PAYMENT_URL = process.env.PAYMENT_URL || 'http://localhost:4004';

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Circuit breaker minimo por servicio downstream. Tras FAILURE_THRESHOLD
 * fallos consecutivos, el circuito se ABRE: durante COOLDOWN_MS el gateway
 * responde 503 inmediatamente sin ni siquiera intentar la llamada de red,
 * evitando que una dependencia lenta o caida arrastre al resto del sistema
 * (patron descrito por Nygard en "Release It!"). Pasado el cooldown, se
 * intenta una llamada de prueba (half-open) para ver si el servicio ya
 * se recupero.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 8000;
const breakers = new Map();

function getBreaker(name) {
  if (!breakers.has(name)) breakers.set(name, { failures: 0, state: 'closed', openedAt: 0 });
  return breakers.get(name);
}

async function callWithBreaker(name, fn) {
  const b = getBreaker(name);

  if (b.state === 'open') {
    if (Date.now() - b.openedAt < COOLDOWN_MS) {
      const err = new Error('circuit_open');
      err.circuitOpen = true;
      throw err;
    }
    b.state = 'half-open';
    log(SERVICE, `circuito en half-open, probando ${name}`);
  }

  try {
    const result = await fn();
    if (b.failures > 0 || b.state === 'half-open') {
      log(SERVICE, `circuito CERRADO nuevamente para ${name}`);
    }
    b.failures = 0;
    b.state = 'closed';
    return result;
  } catch (e) {
    b.failures += 1;
    if (b.failures >= FAILURE_THRESHOLD || b.state === 'half-open') {
      b.state = 'open';
      b.openedAt = Date.now();
      log(SERVICE, `circuito ABIERTO para ${name} tras ${b.failures} fallos`);
    }
    throw e;
  }
}

async function forward(baseUrl, name, path, { method = 'GET', headers = {}, body } = {}) {
  return callWithBreaker(name, async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  });
}

function reply(res, result) {
  res.status(result.status).json({ ...result.data, _gateway: INSTANCE_ID });
}

function handleDownError(res, e, name) {
  if (e.circuitOpen) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: `${name} no responde (circuito abierto). Reintenta en unos segundos.`,
      _gateway: INSTANCE_ID,
    });
  }
  log(SERVICE, `fallo llamando a ${name}`, { error: e.message });
  res.status(502).json({ error: 'bad_gateway', message: `No fue posible contactar a ${name}`, _gateway: INSTANCE_ID });
}

// ---------------- search-service ----------------
app.get('/api/cities', async (req, res) => {
  try {
    reply(res, await forward(SEARCH_URL, 'search-service', '/cities'));
  } catch (e) {
    handleDownError(res, e, 'search-service');
  }
});

app.get('/api/flights', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  try {
    const headers = {};
    if (req.header('x-simulate-partition')) headers['x-simulate-partition'] = req.header('x-simulate-partition');
    reply(res, await forward(SEARCH_URL, 'search-service', `/flights?${qs}`, { headers }));
  } catch (e) {
    handleDownError(res, e, 'search-service');
  }
});

// ---------------- inventory-service ----------------
app.get('/api/flights/:flightId/seats', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  try {
    reply(res, await forward(INVENTORY_URL, 'inventory-service', `/flights/${req.params.flightId}/seats?${qs}`));
  } catch (e) {
    handleDownError(res, e, 'inventory-service');
  }
});

app.post('/api/flights/:flightId/seats/:seatId/hold', async (req, res) => {
  try {
    reply(
      res,
      await forward(INVENTORY_URL, 'inventory-service', `/flights/${req.params.flightId}/seats/${req.params.seatId}/hold`, {
        method: 'POST',
        body: req.body,
      })
    );
  } catch (e) {
    handleDownError(res, e, 'inventory-service');
  }
});

app.post('/api/flights/:flightId/seats/:seatId/release', async (req, res) => {
  try {
    reply(
      res,
      await forward(INVENTORY_URL, 'inventory-service', `/flights/${req.params.flightId}/seats/${req.params.seatId}/release`, {
        method: 'POST',
        body: req.body,
      })
    );
  } catch (e) {
    handleDownError(res, e, 'inventory-service');
  }
});

// ---------------- booking-service ----------------
app.post('/api/bookings', async (req, res) => {
  try {
    reply(res, await forward(BOOKING_URL, 'booking-service', '/bookings', { method: 'POST', body: req.body }));
  } catch (e) {
    handleDownError(res, e, 'booking-service');
  }
});

app.get('/api/bookings/:pnr', async (req, res) => {
  try {
    reply(res, await forward(BOOKING_URL, 'booking-service', `/bookings/${req.params.pnr}`));
  } catch (e) {
    handleDownError(res, e, 'booking-service');
  }
});

// ---------------- estado agregado del sistema ----------------
app.get('/api/status', async (req, res) => {
  const targets = [
    ['search-service', SEARCH_URL],
    ['inventory-service', INVENTORY_URL],
    ['booking-service', BOOKING_URL],
    ['payment-service', PAYMENT_URL],
  ];

  const results = await Promise.all(
    targets.map(async ([name, url]) => {
      const start = Date.now();
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
        const data = await r.json();
        return { name, up: r.ok, latencyMs: Date.now() - start, breaker: getBreaker(name).state, ...data };
      } catch {
        return { name, up: false, latencyMs: Date.now() - start, breaker: getBreaker(name).state };
      }
    })
  );

  res.json({ gateway: INSTANCE_ID, services: results, timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ service: SERVICE, status: 'ok', instance: INSTANCE_ID });
});

app.listen(PORT, () => {
  log(SERVICE, `instancia ${INSTANCE_ID} escuchando en puerto ${PORT}`);
});
