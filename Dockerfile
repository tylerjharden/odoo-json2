FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json server.mjs http.mjs ./
COPY bin ./bin
RUN npm ci --omit=dev
EXPOSE 8788
ENV PORT=8788
CMD ["node", "http.mjs"]
