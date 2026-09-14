FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs http.mjs ./
COPY bin ./bin
EXPOSE 8788
ENV PORT=8788
CMD ["node", "http.mjs"]
