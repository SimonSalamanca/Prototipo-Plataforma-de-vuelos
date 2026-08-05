FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY services/booking-service/package.json ./services/booking-service/package.json
RUN npm install --prefix services/booking-service --omit=dev
COPY services/booking-service ./services/booking-service
WORKDIR /app/services/booking-service
EXPOSE 4003
CMD ["node", "index.js"]
