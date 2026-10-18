# hometrade — local-first autonomous charting terminal (runtime image)
FROM node:22-alpine

# zero external npm deps: only node + the app files are needed
WORKDIR /app
ENV HOMETRADE_DATA=/app/data \
    HOMETRADE_PORT=8890 \
    HOMETRADE_HOST=0.0.0.0 \
    NODE_ENV=production

COPY package.json ./
COPY src/ ./src/
COPY static/ ./static/
COPY README.md ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8890
CMD ["node", "src/server.js"]
