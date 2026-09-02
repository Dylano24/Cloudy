import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../services/cloudyBrandingService.js';
import { registerCloudyEmbedMessages } from '../services/embedRegistryService.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const RECOVERY_KEY = 'global:cloudy:embed-builder-marked-history-recovery';
const RECOVERY_VERSION = 1;
const BATCH_SIZE = 100;
const PAGE_DELAY_MS = 90;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBuilderMarkedMessage(message, botUserId) {
  if (!message?.guildId || message.author?.id !== botUserId || !message.embeds?.length) return false;
  return message.embeds.some(embed =>
    String(embed?.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
  );
}

function readableChannels(guild) {
  const me = guild.members.me;
  return [...guild.channels.cache.values()]
    .filter(channel =>
      (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      && channel.messages?.fetch
      && channel.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
    )
    .sort((a, b) => a.position - b.position);
}

async function recoverGuild(guild, botUserId) {
  let scanned = 0;
  let recovered = 0;

  for (const channel of readableChannels(guild)) {
    let before;

    while (true) {
      const batch = await channel.messages.fetch({ limit: BATCH_SIZE, before }).catch(() => null);
      if (!batch?.size) break;

      scanned += batch.size;
      const marked = [...batch.values()].filter(message => isBuilderMarkedMessage(message, botUserId));
      if (marked.length) {
        await registerCloudyEmbedMessages(marked, 'embed-builder');
        recovered += marked.length;
      }

      const oldest = batch.last();
      if (!oldest || batch.size < BATCH_SIZE) break;
      before = oldest.id;
      await wait(PAGE_DELAY_MS);
    }
  }

  return { scanned, recovered };
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    const timer = setTimeout(async () => {
      try {
        const completed = Number(await getFromDb(RECOVERY_KEY, 0) || 0);
        if (completed >= RECOVERY_VERSION) return;

        let scanned = 0;
        let recovered = 0;
        for (const guild of client.guilds.cache.values()) {
          const result = await recoverGuild(guild, client.user.id);
          scanned += result.scanned;
          recovered += result.recovered;
        }

        await setInDb(RECOVERY_KEY, RECOVERY_VERSION);
        logger.info(`[EMBED_BUILDER] Custom history recovery complete: scanned ${scanned}, restored ${recovered} Builder message(s).`);
      } catch (error) {
        logger.error('[EMBED_BUILDER] Custom history recovery failed:', error);
      }
    }, 3_000);
    timer.unref?.();
  },
};
