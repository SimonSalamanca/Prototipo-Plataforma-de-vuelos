#!/usr/bin/env bash
# Levanta los 5 microservicios en procesos separados para desarrollo local
# (sin Docker). Uso: ./start-all.sh   |   deten con Ctrl+C.
set -e
cd "$(dirname "$0")"

mkdir -p logs
PIDS=()

cleanup() {
  echo ""
  echo "Deteniendo servicios..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  exit 0
}
trap cleanup INT TERM

start() {
  local name=$1; shift
  ("$@" > "logs/$name.log" 2>&1) &
  PIDS+=($!)
  echo "  -> $name iniciado (PID $!) — logs/$name.log"
}

echo "Instalando dependencias (si hace falta)..."
for d in api-gateway services/search-service services/inventory-service services/booking-service services/payment-service; do
  (cd "$d" && [ -d node_modules ] || npm install --omit=dev --silent)
done

echo "Levantando servicios..."
PORT=4001 start search-service    node services/search-service/index.js
PORT=4002 start inventory-service node services/inventory-service/index.js
PORT=4004 start payment-service   node services/payment-service/index.js
sleep 1
INVENTORY_URL=http://localhost:4002 PAYMENT_URL=http://localhost:4004 \
  PORT=4003 start booking-service node services/booking-service/index.js
sleep 1
SEARCH_URL=http://localhost:4001 INVENTORY_URL=http://localhost:4002 \
  BOOKING_URL=http://localhost:4003 PAYMENT_URL=http://localhost:4004 INSTANCE_ID=A \
  PORT=4000 start api-gateway node api-gateway/index.js

echo ""
echo "Listo. Gateway disponible en http://localhost:4000/api"
echo "Estado del sistema: curl http://localhost:4000/api/status"
echo "Presiona Ctrl+C para detener todo."
wait
