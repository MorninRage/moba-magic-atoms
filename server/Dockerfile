# Fly.io — MOBA room hub WebSocket server
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY room-server.mjs ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "room-server.mjs"]
