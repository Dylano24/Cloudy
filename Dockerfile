FROM node:24-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Media extraction stays in the existing bot container; no extra Railway service.
RUN apk add --no-cache ffmpeg yt-dlp gallery-dl

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p logs && chown node:node /usr/src/app /usr/src/app/logs

USER node

EXPOSE 3000

CMD ["npm", "start"]
