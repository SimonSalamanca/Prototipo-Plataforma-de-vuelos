FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY api-gateway/package.json ./api-gateway/package.json
RUN npm install --prefix api-gateway --omit=dev
COPY api-gateway ./api-gateway
WORKDIR /app/api-gateway
EXPOSE 4000
CMD ["node", "index.js"]
