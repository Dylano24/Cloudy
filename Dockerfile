FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
