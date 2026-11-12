FROM node:22-alpine
WORKDIR /app
COPY clamd.mjs scanner.mjs ./
USER node
CMD ["node", "scanner.mjs"]
