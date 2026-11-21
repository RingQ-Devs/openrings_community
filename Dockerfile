FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
