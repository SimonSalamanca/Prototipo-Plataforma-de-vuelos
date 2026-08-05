FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY services/payment-service/package.json ./services/payment-service/package.json
RUN npm install --prefix services/payment-service --omit=dev
COPY services/payment-service ./services/payment-service
WORKDIR /app/services/payment-service
EXPOSE 4004
CMD ["node", "index.js"]
