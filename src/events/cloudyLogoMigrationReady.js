import { readFile } from 'node:fs/promises';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { installCloudyLogoEmbedPatch, normalizeCloudyLogoMessage } from '../services/cloudyLogoService.js';

installCloudyLogoEmbedPatch();

const LOGO_MIGRATION_VERSION = 7;
const LOGO_MIGRATION_STATE_KEY = 'global:cloudy:logo-history-migration-version';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 150;
const CHANNEL_DELAY_MS = 250;
const START_DELAY_MS = 20_000;
const CLOUDY_BOT_AVATAR = new URL('../../assets/cloudy-c-logo-auf-auf.gif', import.meta.url);

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function restoreMissingBotAvatar(client) {
  if (!client?.user || client.user.avatar) return false;
  try {
    const avatar = await readFile(CLOUDY_BOT_AVATAR);
    await client.user.setAvatar(avatar);
    console.log('[CLOUDY_LOGO] Restored missing Cloudy bot profile logo.');
    return true;
  } catch (error) {
    console.error('[CLOUDY_LOGO] Failed to restore missing bot profile logo:', error);
    return false;
  }
}

function readableHistoryChannels(guild) {
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
  for (const channel of readableHistoryChannels(guild)) {
    const result = await migrateChannel(channel, botUserId);
    scanned += result.scanned;
    updated += result.updated;
    if (!result.completed) completed = false;
    await wait(CHANNEL_DELAY_MS);
  }
  console.log(`[CLOUDY_LOGO] ${guild.name}: scanned ${scanned} messages, updated ${updated} existing bot messages.`);
  return { scanned, updated, completed };
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await restoreMissingBotAvatar(client);

    const timer = setTimeout(() => {
      void (async () => {
        const completedVersion = Number(await client.db?.get?.(LOGO_MIGRATION_STATE_KEY, 0).catch(() => 0) || 0);
        if (completedVersion >= LOGO_MIGRATION_VERSION) {
          console.log('[CLOUDY_LOGO] Full logo history migration already completed.');
          return;
        }
        let allGuildsCompleted = true;
        for (const guild of client.guilds.cache.values()) {
          const result = await migrateGuild(guild, client.user.id);
          if (!result.completed) allGuildsCompleted = false;
        }
        if (allGuildsCompleted) {
          await client.db?.set?.(LOGO_MIGRATION_STATE_KEY, LOGO_MIGRATION_VERSION).catch(() => null);
        }
      })().catch(error => console.error('[CLOUDY_LOGO] Existing-message logo migration failed:', error));
    }, START_DELAY_MS);
    timer.unref?.();
  },
};