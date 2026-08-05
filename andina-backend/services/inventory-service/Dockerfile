FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY services/inventory-service/package.json ./services/inventory-service/package.json
RUN npm install --prefix services/inventory-service --omit=dev
COPY services/inventory-service ./services/inventory-service
WORKDIR /app/services/inventory-service
EXPOSE 4002
CMD ["node", "index.js"]
