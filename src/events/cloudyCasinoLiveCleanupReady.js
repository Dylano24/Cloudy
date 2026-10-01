import { Events } from 'discord.js';
import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';

function normalize(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function targetPresentation(title) {
  const normalized = normalize(title);

  const live = normalized.match(/^(blackjack|baccarat)\s*[—-]\s*bet\b/);
  if (live) return { color: 0xFFFFFF, logo: true };

  const outcome = normalized.match(/^(blackjack|baccarat|roulette)\s+(win|loss|bust|push)$/);
  if (!outcome) return null;

  const status = outcome[2];
  return {
    color: status === 'win'
      ? 0x00C49D
      : status === 'push'
        ? 0xFFFFFF
        : 0x7A1712,
    logo: true,
  };
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      try {
        const guild = client.guilds.cache.get(String(process.env.GUILD_ID || ''))
          || client.guilds.cache.first();
        if (!guild) return;

        const channel = guild.channels.cache.find(candidate =>
          candidate?.messages?.fetch
          && String(candidate.name || '').toLowerCase().includes('gambling')
        );
        if (!channel) return;

        let before;
        let scanned = 0;
        let matched = 0;
        let edited = 0;
        const seen = [];

        for (let page = 0; page < 10; page += 1) {
          const batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
          }).catch(() => null);
          if (!batch?.size) break;

          for (const message of batch.values()) {
            scanned += 1;
            if (message.author?.id !== client.user.id || !message.embeds?.length) continue;

            let changed = false;
            const embeds = message.embeds.map(embed => {
              const data = embed.toJSON();
              const presentation = targetPresentation(data.title);
              if (!presentation) return data;

              matched += 1;
              seen.push({
                messageId: message.id,
                title: data.title,
                colorBefore: Number.isInteger(data.color) ? '#' + data.color.toString(16).padStart(6, '0').toUpperCase() : null,
                thumbnailBefore: data.thumbnail?.url || null,
              });

              if (data.color !== presentation.color) {
                data.color = presentation.color;
                changed = true;
              }
              if (presentation.logo && data.thumbnail?.url !== CLOUDY_LOGO_URL) {
                data.thumbnail = { url: CLOUDY_LOGO_URL };
                changed = true;
              }

              return data;
            });

            if (!changed) continue;
            const result = await message.edit({ embeds }).catch(() => null);
            if (result) edited += 1;
          }

          const oldest = batch.last();
          if (!oldest || batch.size < 100) break;
          before = oldest.id;
        }

        console.log('[CASINO_LIVE_CLEANUP]', JSON.stringify({
          channelId: channel.id,
          scanned,
          matched,
          edited,
          seen: seen.slice(0, 20),
        }));
      } catch (error) {
        console.error('[CASINO_LIVE_CLEANUP] failed', error?.stack || error);
      }
    }, 20_000);

    timer.unref?.();
  },
};
