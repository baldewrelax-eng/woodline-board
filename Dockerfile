FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json server.js index.html update.html dashboard.css app-config.js plan-data.js board-model.js cloud-sync.js app.js sw.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
