FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY services/search-service/package.json ./services/search-service/package.json
RUN npm install --prefix services/search-service --omit=dev
COPY services/search-service ./services/search-service
WORKDIR /app/services/search-service
EXPOSE 4001
CMD ["node", "index.js"]
