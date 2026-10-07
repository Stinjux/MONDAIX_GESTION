FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MONDAIX_DB=/app/data/mondaix.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app.cjs ./
COPY src ./src
COPY public ./public
# La base SQLite doit être sur un volume persistant monté sur /app/data.
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:${PORT}/sante || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "app.cjs"]
