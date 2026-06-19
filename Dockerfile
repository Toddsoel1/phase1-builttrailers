# Portable image — runs on any container host (AWS, Azure, Fly.io, your own server).
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
# On first boot run `npm run init-db` once against your DATABASE_URL, then:
CMD ["npm", "start"]
