FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080 DB_PATH=/data/qr.db
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
