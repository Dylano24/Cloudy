import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';

const PAGE_DELAY_MS = 200;
const CHANNEL_DELAY_MS = 350;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function normalizeChannel(channel, botUserId) {
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return { scanned: 0, updated: 0 };

  let scanned = 0;
  let updated = 0;
  let before;

  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    }).catch(() => null);

    if (!messages?.size) break;

    for (const message of messages.values()) {
      scanned += 1;
      if (message.author?.id !== botUserId) continue;
      if (!message.embeds?.length) continue;

      if (await normalizeCloudyMessage(message)) updated += 1;
    }

    before = messages.last()?.id;
    if (messages.size < 100 || !before) break;
    await wait(PAGE_DELAY_MS);
  }

  return { scanned, updated };
}

async function normalizeGuild(client, guild) {
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return;

  let scanned = 0;
  let updated = 0;

  for (const channel of channels.values()) {
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) continue;

    const result = await normalizeChannel(channel, client.user.id);
    scanned += result.scanned;
    updated += result.updated;
    await wait(CHANNEL_DELAY_MS);
  }

  console.log(`[CLOUDY_BRANDING] ${guild.name}: scanned ${scanned} messages, updated ${updated} bot messages.`);
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        for (const guild of client.guilds.cache.values()) {
          await normalizeGuild(client, guild);
        }
      })().catch(error => {
        console.error('[CLOUDY_BRANDING] Existing-message normalization failed:', error);
      });
    }, 15_000);

    timer.unref?.();
  },
};
