const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { log } = require('../../shared/logger');

const SERVICE = 'payment-service';
const PORT = process.env.PORT || 4004;
const FAILURE_RATE = Number(process.env.PAYMENT_FAILURE_RATE || 0.08); // 8% para poder ver la compensacion en accion

const app = express();
app.use(cors());
app.use(express.json());

const charges = new Map();

app.get('/health', (req, res) => {
  res.json({ service: SERVICE, status: 'ok' });
});

app.post('/charge', (req, res) => {
  const { amount, passenger } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'missing_amount' });

  setTimeout(() => {
    const declined = Math.random() < FAILURE_RATE;
    if (declined) {
      log(SERVICE, 'pago RECHAZADO (simulado)', { amount });
      return res.status(402).json({ error: 'payment_declined', message: 'El pago fue rechazado por la pasarela' });
    }
    const authCode = crypto.randomUUID().slice(0, 8).toUpperCase();
    charges.set(authCode, { amount, passenger, chargedAt: Date.now() });
    log(SERVICE, 'pago aprobado', { amount, authCode });
    res.json({ status: 'approved', authCode, amount });
  }, 350 + Math.random() * 250);
});

app.post('/refund', (req, res) => {
  const { authCode } = req.body || {};
  const charge = charges.get(authCode);
  if (!charge) return res.status(404).json({ error: 'charge_not_found' });
  charges.delete(authCode);
  log(SERVICE, 'reembolso ejecutado (accion compensatoria de la saga)', { authCode });
  res.json({ status: 'refunded', authCode });
});

app.listen(PORT, () => {
  log(SERVICE, `escuchando en puerto ${PORT} (tasa de rechazo simulada: ${FAILURE_RATE * 100}%)`);
});
