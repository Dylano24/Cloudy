import { EmbedBuilder, Events } from 'discord.js';
import { getGuildGiveaways } from '../utils/giveaways.js';

const CLOUDY_C_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
const CLOUDY_EMBED_COLOR = 0xFFFFFF;

async function restoreGiveawayBranding(client, guild, giveaway) {
  if (!giveaway?.channelId || !giveaway?.messageId) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const channel = await guild.channels.fetch(giveaway.channelId, { signal: controller.signal }).catch(() => null);
    if (!channel?.messages?.fetch) return;

    const message = await channel.messages.fetch(giveaway.messageId, { signal: controller.signal }).catch(() => null);
    if (!message?.editable || message.author?.id !== client.user?.id || !message.embeds?.length) return;
    if (
      message.embeds[0].thumbnail?.url === CLOUDY_C_LOGO_URL
      && message.embeds[0].color === CLOUDY_EMBED_COLOR
    ) return;

    const embeds = message.embeds.map((embed, index) => {
      const rebuilt = new EmbedBuilder(embed.toJSON());
      return index === 0
        ? rebuilt.setThumbnail(CLOUDY_C_LOGO_URL).setColor(CLOUDY_EMBED_COLOR)
        : rebuilt;
    });

    await message.edit({ embeds }).catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        for (const guild of client.guilds.cache.values()) {
          const giveaways = await getGuildGiveaways(client, guild.id);
          await Promise.allSettled(
            giveaways.map(giveaway => restoreGiveawayBranding(client, guild, giveaway)),
          );
        }
      })();
    }, 5000);

    timer.unref?.();
  },
};
