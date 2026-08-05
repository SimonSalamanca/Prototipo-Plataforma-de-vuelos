const express = require('express');
const cors = require('cors');
const { log } = require('../../shared/logger');

const SERVICE = 'search-service';
const PORT = process.env.PORT || 4001;
const CACHE_TTL_MS = 60_000; // los resultados se consideran "frescos" 60s

const app = express();
app.use(cors());
app.use(express.json());

const CITIES = [
  { code: 'BOG', name: 'Bogota' },
  { code: 'MDE', name: 'Medellin' },
  { code: 'CLO', name: 'Cali' },
  { code: 'CTG', name: 'Cartagena' },
  { code: 'BAQ', name: 'Barranquilla' },
  { code: 'BGA', name: 'Bucaramanga' },
  { code: 'ADZ', name: 'San Andres' },
  { code: 'SMR', name: 'Santa Marta' },
];

/**
 * Cache de resultados en memoria: clave = origin|destination|date
 * Esto modela la replica de lectura (read-replica / cache) tipica de un
 * servicio "AP": siempre respondemos con lo que tengamos, aunque no sea
 * la ultimisima verdad, en vez de bloquear la respuesta esperando
 * consistencia perfecta con el resto del sistema.
 */
const cache = new Map();

function generateFlights(originCode, destCode) {
  const times = ['06:05', '08:40', '11:15', '14:30', '17:50', '20:10'];
  const durations = [65, 80, 95, 110];
  const count = 4 + Math.floor(Math.random() * 2);
  const picks = [...times].sort(() => Math.random() - 0.5).slice(0, count).sort();

  return picks.map((t, i) => {
    const [h, m] = t.split(':').map(Number);
    const dur = durations[Math.floor(Math.random() * durations.length)];
    const arrMin = h * 60 + m + dur;
    const arrT =
      String(Math.floor(arrMin / 60) % 24).padStart(2, '0') +
      ':' +
      String(arrMin % 60).padStart(2, '0');
    const seatsAvail = 3 + Math.floor(Math.random() * 28);
    const price = 195000 + Math.floor(Math.random() * 22) * 9500;

    return {
      id: `F${originCode}${destCode}${i}${Date.now() % 100000}`,
      flightNo: 'AN ' + (180 + Math.floor(Math.random() * 700)),
      depTime: t,
      arrTime: arrT,
      durationMin: dur,
      origin: originCode,
      destination: destCode,
      seatsAvail,
      price,
    };
  });
}

function cacheKey(origin, destination, date) {
  return `${origin}|${destination}|${date}`;
}

app.get('/health', (req, res) => {
  res.json({ service: SERVICE, status: 'ok', capMode: 'AP', cachedRoutes: cache.size });
});

app.get('/cities', (req, res) => {
  res.json(CITIES);
});

app.get('/flights', (req, res) => {
  const { origin, destination, date } = req.query;
  const simulatePartition = req.header('x-simulate-partition') === 'true';

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'missing_params', message: 'origin, destination y date son requeridos' });
  }
  if (origin === destination) {
    return res.status(400).json({ error: 'same_city', message: 'origen y destino deben ser distintos' });
  }

  const key = cacheKey(origin, destination, date);
  const cached = cache.get(key);
  const isFresh = cached && Date.now() - cached.generatedAt < CACHE_TTL_MS;

  // Modelo AP: si hay particion simulada, SIEMPRE servimos desde cache
  // (aunque este vencida) en vez de fallar. Disponibilidad > frescura.
  if (simulatePartition && cached) {
    log(SERVICE, 'sirviendo desde cache local (particion simulada activa)', { key });
    return res.json({
      flights: cached.flights,
      meta: { source: 'cache', stale: true, generatedAt: cached.generatedAt, capMode: 'AP' },
    });
  }

  if (isFresh) {
    return res.json({
      flights: cached.flights,
      meta: { source: 'cache', stale: false, generatedAt: cached.generatedAt, capMode: 'AP' },
    });
  }

  // Genera un nuevo resultado y actualiza la cache (escritura en segundo plano
  // simulada: no bloqueamos al cliente por esto, la respuesta ya sale con los datos nuevos)
  const flights = generateFlights(origin, destination);
  cache.set(key, { flights, generatedAt: Date.now() });
  log(SERVICE, 'resultados generados y cacheados', { key, count: flights.length });

  res.json({
    flights,
    meta: { source: 'origin', stale: false, generatedAt: Date.now(), capMode: 'AP' },
  });
});

app.listen(PORT, () => {
  log(SERVICE, `escuchando en puerto ${PORT} (modo CAP: AP - disponibilidad)`);
});
