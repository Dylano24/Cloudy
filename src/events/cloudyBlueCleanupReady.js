import { Events } from 'discord.js';
import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';

const MARKER = 'global:cloudy-blue-cleanup:2026-10-01:v1';
const MANUAL_BUILDER_MARKER = '\u200B';
const SKIP_SLUGS = new Set([
  'timeout-logs',
  'kick-logs',
  'ban-logs',
  'invitation-logs',
  'reports',
  'alert-activity',
  'payments-logs',
  'ticket-logs',
  'ticket-transcripts',
  'posted-reviews',
]);
const SKIP_PARENTS = new Set(['⇀ Owner ↼', '⇀ Tickets feed ↼']);

function slug(name = '') {
  let value = String(name).toLowerCase();
  for (const separator of ['│', '｜', '|']) {
    if (value.includes(separator)) value = value.split(separator).at(-1);
  }
  return value.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isBlue(color) {
  if (!Number.isInteger(color)) return false;
  const red = (color >> 16) & 0xFF;
  const green = (color >> 8) & 0xFF;
  const blue = color & 0xFF;
  return blue >= 120 && blue > red * 1.18 && blue > green * 1.06;
}

function isManualBuilderMessage(message) {
  return message.embeds?.some(embed =>
    String(embed.footer?.text || '').endsWith(MANUAL_BUILDER_MARKER)
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      try {
        if (client.db?.get && await client.db.get(MARKER).catch(() => false)) {
          console.log('[CLOUDY_BLUE_CLEANUP] already complete');
          return;
        }

        let channelsScanned = 0;
        let messagesScanned = 0;
        let messagesEdited = 0;
        let blueFixed = 0;
        let logosAdded = 0;

        for (const guild of client.guilds.cache.values()) {
          const channels = [...guild.channels.cache.values()]
            .filter(channel => channel?.messages?.fetch && !channel.isThread?.());

          for (const channel of channels) {
            const channelSlug = slug(channel.name);
            if (SKIP_SLUGS.has(channelSlug) || SKIP_PARENTS.has(channel.parent?.name)) continue;

            channelsScanned += 1;
            let before;

            while (true) {
              const batch = await channel.messages.fetch({
                limit: 100,
                ...(before ? { before } : {}),
              }).catch(() => null);

              if (!batch?.size) break;

              for (const message of batch.values()) {
                messagesScanned += 1;
                if (message.author?.id !== client.user.id || !message.embeds?.length) continue;
                if (isManualBuilderMessage(message)) continue;

                let changed = false;
                let fixedBlue = false;
                let addedLogo = false;

                const embeds = message.embeds.map(embed => {
                  const data = embed.toJSON();

                  if (isBlue(data.color)) {
                    data.color = 0xFFFFFF;
                    changed = true;
                    fixedBlue = true;
                  }

                  if (!data.thumbnail?.url && (channelSlug === 'gambling' || fixedBlue)) {
                    data.thumbnail = { url: CLOUDY_LOGO_URL };
                    changed = true;
                    addedLogo = true;
                  }

                  return data;
                });

                if (!changed) continue;

                const edited = await message.edit({ embeds }).catch(() => null);
                if (!edited) continue;

                messagesEdited += 1;
                if (fixedBlue) blueFixed += 1;
                if (addedLogo) logosAdded += 1;
              }

              const oldest = batch.last();
              if (!oldest || batch.size < 100) break;
              before = oldest.id;
            }
          }
        }

        if (client.db?.set) {
          await client.db.set(MARKER, {
            completedAt: new Date().toISOString(),
            channelsScanned,
            messagesScanned,
            messagesEdited,
            blueFixed,
            logosAdded,
          }).catch(() => {});
        }

        console.log('[CLOUDY_BLUE_CLEANUP]', JSON.stringify({
          complete: true,
          channelsScanned,
          messagesScanned,
          messagesEdited,
          blueFixed,
          logosAdded,
        }));
      } catch (error) {
        console.error('[CLOUDY_BLUE_CLEANUP] failed', error?.stack || error);
      }
    }, 20_000);

    timer.unref?.();
  },
};
