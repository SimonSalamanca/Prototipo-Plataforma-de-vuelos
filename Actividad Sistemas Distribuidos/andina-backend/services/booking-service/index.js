const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { log } = require('../../shared/logger');

const SERVICE = 'booking-service';
const PORT = process.env.PORT || 4003;
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:4002';
const PAYMENT_URL = process.env.PAYMENT_URL || 'http://localhost:4004';

const app = express();
app.use(cors());
app.use(express.json());

const bookings = new Map(); // pnr -> booking

function pnr() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function validatePassenger(p) {
  const errors = {};
  if (!p || typeof p !== 'object') return { name: 'requerido' };
  if (!p.name || p.name.trim().length < 4 || !p.name.trim().includes(' ')) errors.name = 'nombre completo invalido';
  if (!p.doc || p.doc.trim().length < 5) errors.doc = 'documento invalido';
  if (!p.phone || p.phone.replace(/\D/g, '').length < 7) errors.phone = 'telefono invalido';
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.email = 'correo invalido';
  return Object.keys(errors).length ? errors : null;
}

app.get('/health', (req, res) => {
  res.json({ service: SERVICE, status: 'ok', totalBookings: bookings.size });
});

app.get('/bookings/:pnrCode', (req, res) => {
  const booking = bookings.get(req.params.pnrCode.toUpperCase());
  if (!booking) return res.status(404).json({ error: 'not_found' });
  res.json(booking);
});

/**
 * POST /bookings
 * body: { flightId, seatId, holdToken, price, flightSummary, passenger }
 *
 * Este endpoint es el nucleo transaccional del sistema (CP). Ejecuta una
 * saga de dos pasos con compensacion:
 *   1) cobra el pago
 *   2) confirma el asiento en inventory-service usando el holdToken
 * Si el paso 2 falla (otro pasajero gano el asiento o el hold expiro),
 * se revierte el paso 1 con un reembolso -- nunca se cobra sin viaje
 * confirmado, y nunca se vende el mismo asiento dos veces.
 */
app.post('/bookings', async (req, res) => {
  const { flightId, seatId, holdToken, price, flightSummary, passenger } = req.body || {};

  if (!flightId || !seatId || !holdToken || !price) {
    return res.status(400).json({ error: 'missing_fields', message: 'flightId, seatId, holdToken y price son requeridos' });
  }
  const passengerErrors = validatePassenger(passenger);
  if (passengerErrors) {
    return res.status(400).json({ error: 'invalid_passenger', fields: passengerErrors });
  }

  log(SERVICE, 'iniciando saga de reserva', { flightId, seatId });

  // ---- paso 1: cobro ----
  let payment;
  try {
    const payRes = await fetch(`${PAYMENT_URL}/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: price, passenger }),
    });
    if (!payRes.ok) {
      const err = await payRes.json().catch(() => ({}));
      log(SERVICE, 'saga abortada: pago rechazado', { flightId, seatId });
      return res.status(402).json({ error: 'payment_declined', message: err.message || 'El pago fue rechazado' });
    }
    payment = await payRes.json();
  } catch (e) {
    log(SERVICE, 'payment-service no disponible', { error: e.message });
    return res.status(503).json({ error: 'payment_service_unavailable', message: 'No fue posible procesar el pago, intenta de nuevo' });
  }

  // ---- paso 2: confirmacion del asiento (region CP critica) ----
  let confirmRes;
  try {
    confirmRes = await fetch(`${INVENTORY_URL}/flights/${flightId}/seats/${seatId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdToken }),
    });
  } catch (e) {
    log(SERVICE, 'inventory-service no disponible, ejecutando compensacion (reembolso)', { error: e.message });
    await fetch(`${PAYMENT_URL}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authCode: payment.authCode }),
    }).catch(() => {});
    return res.status(503).json({ error: 'inventory_service_unavailable', message: 'No fue posible confirmar el asiento, tu pago fue revertido' });
  }

  if (!confirmRes.ok) {
    const err = await confirmRes.json().catch(() => ({}));
    log(SERVICE, 'saga abortada: asiento ya no disponible, ejecutando compensacion (reembolso)', { flightId, seatId });
    await fetch(`${PAYMENT_URL}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authCode: payment.authCode }),
    }).catch(() => {});
    return res.status(409).json({
      error: 'seat_taken',
      message: err.message || `El asiento ${seatId} fue tomado por otro pasajero antes de confirmar tu reserva. Tu pago fue revertido automaticamente.`,
    });
  }

  // ---- paso 3: persistencia de la reserva confirmada ----
  const code = pnr();
  const booking = {
    pnr: code,
    flightId,
    seatId,
    price,
    flightSummary: flightSummary || null,
    passenger,
    authCode: payment.authCode,
    createdAt: new Date().toISOString(),
  };
  bookings.set(code, booking);
  log(SERVICE, 'saga completada: reserva confirmada', { pnr: code, flightId, seatId });

  res.status(201).json(booking);
});

app.listen(PORT, () => {
  log(SERVICE, `escuchando en puerto ${PORT}`);
});
