FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs routing.mjs models.mjs providers.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
