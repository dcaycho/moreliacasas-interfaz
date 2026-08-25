FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 80

ENV PORT=80

CMD ["npm", "start"]
