import { Events, PermissionFlagsBits } from 'discord.js';
import { installCloudyLogoEmbedPatch, normalizeCloudyLogoMessage } from '../services/cloudyLogoService.js';

installCloudyLogoEmbedPatch();

// Keep the CDN swap separate from older image cleanups. Some databases have a
// newer legacy-migration marker already, but still contain the direct GitHub
// URL that flickers in the desktop Discord client.
const LOGO_MIGRATION_VERSION = 3;
const LOGO_MIGRATION_STATE_KEY = 'global:cloudy:logo-cdn-migration-version';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 150;
const CHANNEL_DELAY_MS = 250;
const START_DELAY_MS = 20_000;
const scheduledClients = new WeakSet();

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readableHistoryChannels(guild) {
  const me = guild.members.me;
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  return [...channels.values()]
    .filter(channel =>
      channel?.isTextBased?.()
      && channel.messages?.fetch
      && channel.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
    )
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

async function migrateChannel(channel, botUserId) {
  let before;
  let scanned = 0;
  let updated = 0;
  while (true) {
    const messages = await channel.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) }).catch(() => null);
    if (!messages) return { scanned, updated, completed: false };
    if (!messages.size) break;
    for (const message of messages.values()) {
      scanned += 1;
      if (message.author?.id !== botUserId || !message.embeds?.length) continue;
      if (await normalizeCloudyLogoMessage(message)) updated += 1;
    }
    before = messages.last()?.id;
    if (messages.size < PAGE_SIZE || !before) break;
    await wait(PAGE_DELAY_MS);
  }
  return { scanned, updated, completed: true };
}

async function migrateGuild(guild, botUserId) {
  let scanned = 0;
  let updated = 0;
  let completed = true;
  for (const channel of await readableHistoryChannels(guild)) {
    const result = await migrateChannel(channel, botUserId);
    scanned += result.scanned;
    updated += result.updated;
    if (!result.completed) completed = false;
    await wait(CHANNEL_DELAY_MS);
  }
  console.log(`[CLOUDY_LOGO] CDN migration ${guild.name}: scanned ${scanned} messages, updated ${updated} bot messages.`);
  return { scanned, updated, completed };
}

export function scheduleCloudyLogoMigration(client) {
  if (!client || scheduledClients.has(client)) return false;
  scheduledClients.add(client);

  const timer = setTimeout(() => {
    void (async () => {
      const completedVersion = Number(await client.db?.get?.(LOGO_MIGRATION_STATE_KEY, 0).catch(() => 0) || 0);
      if (completedVersion >= LOGO_MIGRATION_VERSION) {
        console.log('[CLOUDY_LOGO] CDN media migration already completed.');
        return;
      }

      const guilds = [...client.guilds.cache.values()];
      if (!guilds.length) {
        console.warn('[CLOUDY_LOGO] CDN media migration deferred: no guild cache is available yet.');
        scheduledClients.delete(client);
        return;
      }

      let allGuildsCompleted = true;
      for (const guild of guilds) {
        const result = await migrateGuild(guild, client.user.id);
        if (!result.completed) allGuildsCompleted = false;
      }
      if (allGuildsCompleted) {
        await client.db?.set?.(LOGO_MIGRATION_STATE_KEY, LOGO_MIGRATION_VERSION).catch(() => null);
      }
    })().catch(error => console.error('[CLOUDY_LOGO] Existing-message media migration failed:', error));
  }, START_DELAY_MS);
  timer.unref?.();
  return true;
}

export default {
  name: Events.ClientReady,
  once: true,
  execute() {
    // `ready.js` owns the schedule. Keeping this tiny listener preserves the
    // eager EmbedBuilder patch above without letting a duplicate startup
    // callback reserve the migration before the proven ready route runs.
  },
};
