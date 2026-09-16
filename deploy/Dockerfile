# Crédit ados : un seul conteneur qui sert le front statique ET l'API.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787
# Utilisateur `node` (uid 1000) : /root/credit-ado-data lui appartient sur l'hôte.
USER node
CMD ["node", "server/index.mjs"]
