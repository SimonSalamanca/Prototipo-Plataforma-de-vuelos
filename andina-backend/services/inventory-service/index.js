const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { log } = require('../../shared/logger');

const SERVICE = 'inventory-service';
const PORT = process.env.PORT || 4002;
const ROWS = 8;
const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];
const DEFAULT_HOLD_TTL_MS = 8000;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Estado en memoria por vuelo. En produccion esto vive en una base de datos
 * transaccional (Postgres) con un UNIQUE constraint sobre (flight_id, seat_id)
 * o un SELECT ... FOR UPDATE, y/o en Redis con comandos atomicos (SETNX).
 * Aqui se modela el mismo principio con una region critica sincronica de
 * Node: entre el chequeo de estado y su escritura no hay ningun `await`,
 * por lo que dos solicitudes concurrentes NUNCA pueden "ganar" el mismo asiento.
 */
const flightStore = new Map(); // flightId -> { seats: Map(seatId -> seatRecord), chaosTimer }

function buildSeatId(row, col) {
  return `${row}${col}`;
}

function ensureFlight(flightId, seatsAvail) {
  if (flightStore.has(flightId)) return flightStore.get(flightId);

  const total = ROWS * COLS.length;
  const avail = Math.min(Math.max(Number(seatsAvail) || 20, 2), total);
  const takenTarget = total - avail;

  const ids = [];
  for (let r = 1; r <= ROWS; r++) for (const c of COLS) ids.push(buildSeatId(r, c));
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const takenSet = new Set(shuffled.slice(0, takenTarget));

  const seats = new Map();
  for (const id of ids) {
    seats.set(id, {
      id,
      status: takenSet.has(id) ? 'taken' : 'available', // available | held | taken
      holdToken: null,
      heldAt: null,
    });
  }

  const record = { seats };
  flightStore.set(flightId, record);

  // Caos de fondo: pasajeros "externos" reservando asientos en tiempo real,
  // igual que en el prototipo de frontend. Sirve para que la demo de
  // conflictos sea real y no solo forzada por el boton de prueba.
  record.chaosTimer = setInterval(() => {
    const free = [...seats.values()].filter((s) => s.status === 'available');
    if (free.length <= 2) return;
    const pick = free[Math.floor(Math.random() * free.length)];
    pick.status = 'taken';
    log(SERVICE, 'asiento tomado por trafico externo simulado', { flightId, seatId: pick.id });
  }, 5000 + Math.random() * 3000);

  return record;
}

app.get('/health', (req, res) => {
  res.json({ service: SERVICE, status: 'ok', capMode: 'CP', activeFlights: flightStore.size });
});

app.get('/flights/:flightId/seats', (req, res) => {
  const { flightId } = req.params;
  const { seatsAvail } = req.query;
  const record = ensureFlight(flightId, seatsAvail);
  res.json({
    flightId,
    seats: [...record.seats.values()].map((s) => ({ id: s.id, status: s.status === 'held' ? 'held' : s.status })),
    capMode: 'CP',
  });
});

app.post('/flights/:flightId/seats/:seatId/hold', (req, res) => {
  const { flightId, seatId } = req.params;
  const ttlMs = Number(req.body?.ttlMs) || DEFAULT_HOLD_TTL_MS;
  const record = flightStore.get(flightId);

  if (!record || !record.seats.has(seatId)) {
    return res.status(404).json({ error: 'seat_not_found' });
  }

  // ---- region critica sincronica: chequeo + escritura sin ningun await ----
  const seat = record.seats.get(seatId);
  if (seat.status !== 'available') {
    log(SERVICE, 'hold RECHAZADO - asiento no disponible', { flightId, seatId, status: seat.status });
    return res.status(409).json({
      error: 'seat_unavailable',
      message: `El asiento ${seatId} ya no esta disponible`,
      status: seat.status,
    });
  }
  const holdToken = crypto.randomUUID();
  seat.status = 'held';
  seat.holdToken = holdToken;
  seat.heldAt = Date.now();
  // ---- fin de la region critica ----

  log(SERVICE, 'hold CONCEDIDO (bloqueo optimista)', { flightId, seatId, holdToken });

  const timer = setTimeout(() => {
    if (seat.status === 'held' && seat.holdToken === holdToken) {
      seat.status = 'available';
      seat.holdToken = null;
      log(SERVICE, 'hold expirado, asiento liberado automaticamente', { flightId, seatId });
    }
  }, ttlMs);
  timer.unref?.();

  res.json({ holdToken, seatId, expiresInMs: ttlMs, capMode: 'CP' });
});

app.post('/flights/:flightId/seats/:seatId/release', (req, res) => {
  const { flightId, seatId } = req.params;
  const { holdToken } = req.body || {};
  const record = flightStore.get(flightId);
  const seat = record?.seats.get(seatId);

  if (!seat) return res.status(404).json({ error: 'seat_not_found' });

  if (seat.status === 'held' && seat.holdToken === holdToken) {
    seat.status = 'available';
    seat.holdToken = null;
    log(SERVICE, 'hold liberado por el cliente', { flightId, seatId });
    return res.json({ released: true });
  }
  res.json({ released: false, currentStatus: seat.status });
});

app.post('/flights/:flightId/seats/:seatId/confirm', (req, res) => {
  const { flightId, seatId } = req.params;
  const { holdToken } = req.body || {};
  const record = flightStore.get(flightId);
  const seat = record?.seats.get(seatId);

  if (!seat) return res.status(404).json({ error: 'seat_not_found' });

  if (seat.status !== 'held' || seat.holdToken !== holdToken) {
    log(SERVICE, 'confirm RECHAZADO - hold invalido o expirado', { flightId, seatId });
    return res.status(409).json({
      error: 'hold_invalid_or_expired',
      message: `No fue posible confirmar el asiento ${seatId}: el bloqueo expiro o ya fue tomado por otro pasajero`,
      status: seat.status,
    });
  }

  seat.status = 'taken';
  seat.holdToken = null;
  log(SERVICE, 'asiento CONFIRMADO de forma definitiva', { flightId, seatId });
  res.json({ confirmed: true, seatId, capMode: 'CP' });
});

app.listen(PORT, () => {
  log(SERVICE, `escuchando en puerto ${PORT} (modo CAP: CP - consistencia)`);
});
