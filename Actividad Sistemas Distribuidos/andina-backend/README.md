# Andina — Backend de microservicios

Backend funcional para el prototipo **Andina** (reserva de vuelos). Implementa la
arquitectura de microservicios y las decisiones CAP definidas en el análisis previo:
búsqueda con prioridad de **disponibilidad (AP)** e inventario/reservas con
prioridad de **consistencia (CP)**, más mitigación del punto único de fallo del
API Gateway mediante redundancia.

## 1. Arquitectura

```
Cliente (Andina_App_Reservas_Vuelos.html)
        │
        ▼
 NGINX (load balancer, puerto 8080)
        │
  ┌─────┴─────┐
  ▼           ▼
Gateway A   Gateway B      ← dos réplicas + circuit breaker por servicio
  │  │  │  │
  │  │  │  └──────────────► payment-service   (4004) — cobro / reembolso (stub)
  │  │  └─────────────────► booking-service   (4003) — orquesta la saga de reserva
  │  └────────────────────► inventory-service (4002) — CP: asientos, bloqueo optimista
  └───────────────────────► search-service    (4001) — AP: búsqueda de vuelos (caché)
```

| Servicio | Puerto | Prioridad CAP | Responsabilidad |
|---|---|---|---|
| `search-service` | 4001 | **AP** | Genera/cachea resultados de vuelos por ruta+fecha. Bajo partición simulada, sigue respondiendo desde caché aunque esté desactualizada. |
| `inventory-service` | 4002 | **CP** | Mapa de asientos y bloqueo optimista (`hold` → `confirm`/`release`). La región crítica es síncrona: no hay ningún `await` entre el chequeo y la escritura del estado del asiento, por lo que dos solicitudes concurrentes nunca pueden ganar el mismo asiento. |
| `booking-service` | 4003 | **CP** | Orquesta la saga de reserva: cobra el pago y luego confirma el asiento. Si la confirmación falla (asiento ya tomado / hold vencido), ejecuta una **acción compensatoria** (reembolso) — nunca se cobra sin viaje confirmado. |
| `payment-service` | 4004 | — | Cobro/reembolso simulados (`PAYMENT_FAILURE_RATE` configurable para probar la compensación). |
| `api-gateway` | 4000 | — | Único punto de entrada. Aplica **circuit breaker** por servicio downstream (abre tras 3 fallos consecutivos, cooldown de 8s) y expone `/api/status` con la salud agregada de todo el sistema. |
| `nginx` (load balancer) | 8080 | — | Balancea entre `gateway-a` y `gateway-b`. Si una instancia del gateway cae, todo el tráfico sigue sirviéndose desde la otra — mitigación real del SPOF identificado en el análisis. |

## 2. Cómo ejecutarlo

### Opción A — Docker Compose (recomendada, incluye las 2 réplicas del gateway + NGINX)

```bash
docker compose up --build
```

Backend disponible en `http://localhost:8080/api/...`

### Opción B — Local con Node (sin Docker, una sola instancia de gateway)

Requiere Node.js 18+.

```bash
./start-all.sh
```

Backend disponible en `http://localhost:4000/api/...`. Ctrl+C detiene todo.

## 3. Contrato de API (a través del gateway)

```
GET  /api/status
GET  /api/cities
GET  /api/flights?origin=BOG&destination=MDE&date=2026-08-10
GET  /api/flights/:flightId/seats?seatsAvail=15
POST /api/flights/:flightId/seats/:seatId/hold      { ttlMs? }
POST /api/flights/:flightId/seats/:seatId/release   { holdToken }
POST /api/bookings                                  { flightId, seatId, holdToken, price, passenger }
GET  /api/bookings/:pnr
```

`passenger`: `{ name, doc, phone, email }` (mismas validaciones que el formulario del frontend).

Respuestas de error relevantes:
- `409 seat_unavailable` — al pedir el `hold`, el asiento ya está tomado/bloqueado por otra persona.
- `409 seat_taken` — al confirmar la reserva, el `hold` venció o alguien más lo ganó primero; el pago ya fue revertido.
- `402 payment_declined` — la pasarela de pago rechazó el cobro.
- `503 service_unavailable` — el circuit breaker está abierto para ese servicio.

## 4. Probar la consistencia bajo concurrencia

```bash
curl -s "http://localhost:4000/api/flights/DEMO1/seats?seatsAvail=40"

for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:4000/api/flights/DEMO1/seats/1A/hold -d '{}' -H "Content-Type: application/json" &
done; wait
```

Resultado esperado: **una sola** respuesta `200` con `holdToken`; el resto responde `409 seat_unavailable`. Así se valida en código real la consistencia fuerte (CP) descrita en el análisis arquitectónico, incluso frente a solicitudes verdaderamente simultáneas.

## 5. Conectar el frontend existente

`Andina_App_Reservas_Vuelos.html` hoy genera los vuelos y el mapa de asientos
con JavaScript local (`generateFlights`, `openSeatMap`). Para conectarlo a este
backend real, hay que reemplazar esas funciones por `fetch` al gateway:

```js
const API = 'http://localhost:8080/api'; // o :4000 si corres sin Docker

// en vez de generateFlights(o,d):
const res = await fetch(`${API}/flights?origin=${o}&destination=${d}&date=${state.date}`);
const { flights } = await res.json();

// en vez de construir el mapa de asientos localmente:
const seatsRes = await fetch(`${API}/flights/${f.id}/seats?seatsAvail=${f.seatsAvail}`);
const { seats } = await seatsRes.json();

// al elegir asiento, pedir el hold antes de mostrarlo como "tuyo":
const holdRes = await fetch(`${API}/flights/${f.id}/seats/${seatId}/hold`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
if (holdRes.status === 409) { /* mostrar el mismo conflict-note que ya existe en la UI */ }

// al confirmar (botón "Confirmar y reservar"):
const bookingRes = await fetch(`${API}/bookings`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ flightId:f.id, seatId, holdToken, price:f.price, passenger })
});
if (bookingRes.status === 409) { /* asiento perdido tras el hold: mismo flujo de "sniped" que ya maneja la UI */ }
const booking = await bookingRes.json(); // usar booking.pnr en el pase de abordar
```

Si quieres, puedo hacer esta integración completa directamente sobre tu archivo
`Andina_App_Reservas_Vuelos.html` en una siguiente iteración.

## 6. Limitaciones conocidas del prototipo (y su solución en producción)

- **Estado en memoria**: cada servicio guarda su estado en variables de proceso.
  Sirve para demostrar la arquitectura, pero no persiste reinicios ni permite
  escalar `inventory-service` a más de una instancia. En producción: Postgres
  con `SELECT ... FOR UPDATE` o un `UNIQUE` constraint `(flight_id, seat_id)`
  para el inventario, y Redis (`SETNX`) para los holds de corta duración.
- **`search-service` de una sola instancia**: para escalar de verdad la
  disponibilidad de lectura, se desplegarían varias réplicas detrás del
  gateway con una caché compartida (Redis) o un motor de búsqueda (Elasticsearch/OpenSearch).
- **Pagos simulados**: `payment-service` no se conecta a una pasarela real;
  el `PAYMENT_FAILURE_RATE` existe para poder demostrar la compensación de la saga.
