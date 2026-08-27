import { EmbedBuilder, Events } from 'discord.js';
import { getGuildGiveaways } from '../utils/giveaways.js';

const CLOUDY_C_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';

async function restoreGiveawayLogo(client, guild, giveaway) {
  if (!giveaway?.channelId || !giveaway?.messageId) return;

  const channel = await guild.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.messages?.fetch) return;

  const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (!message?.editable || message.author?.id !== client.user?.id || !message.embeds?.length) return;
  if (message.embeds[0].thumbnail?.url === CLOUDY_C_LOGO_URL) return;

  const embeds = message.embeds.map((embed, index) => {
    const rebuilt = new EmbedBuilder(embed.toJSON());
    return index === 0 ? rebuilt.setThumbnail(CLOUDY_C_LOGO_URL) : rebuilt;
  });

  await message.edit({ embeds }).catch(() => null);
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
            giveaways.map(giveaway => restoreGiveawayLogo(client, guild, giveaway)),
          );
        }
      })();
    }, 5000);

    timer.unref?.();
  },
};
