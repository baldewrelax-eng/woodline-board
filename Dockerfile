FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json server.js index.html ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
