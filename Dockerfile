FROM node:24-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Media extraction stays in the existing bot container; no extra Railway service.
RUN apk add --no-cache ffmpeg yt-dlp gallery-dl su-exec

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p logs && chown node:node /usr/src/app /usr/src/app/logs

# Railway mounts volumes at runtime, after Docker image build. The image's
# normal node user cannot write to a newly mounted root-owned volume.
# Bootstrap as root only to grant the node user access to its own media
# directory; immediately drop privileges before starting the bot.
COPY scripts/cloudy-volume-entrypoint.sh /usr/local/bin/cloudy-volume-entrypoint
RUN chmod 755 /usr/local/bin/cloudy-volume-entrypoint

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/cloudy-volume-entrypoint"]
CMD ["npm", "start"]
