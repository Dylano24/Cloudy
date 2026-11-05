// Patchbot: game update posts in a channel each server chooses on the
// website (owner's choice, like the PatchBot bot). Rust only for now.
// Cloudy's own #rust-patch-notes keeps its built-in poster; Patchbot never
// posts there. Only updates that appear after Patchbot is switched on (or its
// channel changes) are posted; "Post latest update" sends the current one.
import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { getGuildConfig } from './config/guildConfig.js';
import { preparePatchNotesBanner, samePatchArticle } from './patchNotesBannerService.js';
import { buildRustPatchPayload, fetchLatestRustPatch } from './rustPatchNotesService.js';

export const PATCHBOT_GAMES = Object.freeze({
  rust: { name: 'Rust', fetchLatest: () => fetchLatestRustPatch(), buildPayload: (patch, banner) => buildRustPatchPayload(patch, banner) },
});
const SNOWFLAKE = /^\d{17,20}$/;
const FAILURE_LOG_INTERVAL_MS = 60 * 60_000;
let lastFailureLogAt = 0;

const lastKey = (guildId, game, channelId) => `guild:${guildId}:patchbot:${game}:${channelId}:last-link:v1`;

export function normalizePatchbotConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const games = value.games && typeof value.games === 'object' && !Array.isArray(value.games) ? value.games : { rust: true };
  return {
    enabled: value.enabled === true,
    channelId: SNOWFLAKE.test(String(value.channelId || '')) ? String(value.channelId) : null,
    roleId: SNOWFLAKE.test(String(value.roleId || '')) ? String(value.roleId) : null,
    games: Object.fromEntries(Object.keys(PATCHBOT_GAMES).map(game => [game, games[game] === true])),
  };
}

export async function getPatchbotConfig(client, guildId) {
  return normalizePatchbotConfig((await getGuildConfig(client, guildId))?.patchbot);
}

function patchbotChannel(guild, channelId) {
  const channel = guild?.channels?.cache?.get?.(channelId);
  if (!channel?.isTextBased?.() || !channel.send) return null;
  const me = guild.members?.me;
  const permissions = me && channel.permissionsFor?.(me);
  if (permissions && !permissions.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
  ])) return null;
  return channel;
}

async function sendUpdate(client, guild, channel, config, game, patch) {
  const definition = PATCHBOT_GAMES[game];
  const banner = await preparePatchNotesBanner(patch);
  const payload = definition.buildPayload(patch, banner);
  await channel.send({
    ...payload,
    ...(config.roleId ? { content: `<@&${config.roleId}>` } : {}),
    allowedMentions: { parse: [], roles: config.roleId ? [config.roleId] : [] },
  });
  await client.db.set(lastKey(guild.id, game, channel.id), patch.link);
}

async function alreadyInChannel(client, channel, patch) {
  const recent = await channel.messages?.fetch?.({ limit: 50 }).catch(() => null);
  return Boolean(recent?.some?.(message => message.author?.id === client.user?.id
    && message.embeds?.some(embed => samePatchArticle(embed.url, patch.link))));
}

// Runs after each check of the game's feed. Never throws.
export async function deliverPatchbotUpdates(client, game, patch, { skipChannelIds = [] } = {}) {
  if (!patch?.link || !PATCHBOT_GAMES[game]) return 0;
  let posted = 0;
  for (const guild of client?.guilds?.cache?.values?.() || []) {
    try {
      const config = await getPatchbotConfig(client, guild.id);
      if (!config.enabled || !config.games[game] || !config.channelId || skipChannelIds.includes(config.channelId)) continue;
      const channel = patchbotChannel(guild, config.channelId);
      if (!channel) continue;
      await Mutex.runExclusive(`patchbot:${guild.id}:${game}`, async () => {
        const key = lastKey(guild.id, game, channel.id);
        const last = await client.db.get(key);
        // First check after switching on: remember the current update, so
        // only newer ones are posted.
        if (!last) return client.db.set(key, patch.link);
        if (samePatchArticle(last, patch.link)) return undefined;
        if (await alreadyInChannel(client, channel, patch)) return client.db.set(key, patch.link);
        await sendUpdate(client, guild, channel, config, game, patch);
        posted += 1;
        return undefined;
      });
    } catch (error) {
      if (Date.now() - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
        lastFailureLogAt = Date.now();
        logger.warn(`Patchbot ${game} update for guild ${guild.id} failed:`, error);
      }
    }
  }
  return posted;
}

// Website action "Post latest update": sends the current update now.
export async function postLatestPatchbotUpdate(client, guild, game = 'rust') {
  const config = await getPatchbotConfig(client, guild.id);
  if (!config.channelId) throw Object.assign(new Error('Choose a Patchbot channel first.'), { userMessage: 'Choose a Patchbot channel first.' });
  const channel = patchbotChannel(guild, config.channelId);
  if (!channel) {
    const message = 'Cloudy needs View Channel, Send Messages, Embed Links and Attach Files in the Patchbot channel.';
    throw Object.assign(new Error(message), { userMessage: message });
  }
  const patch = await PATCHBOT_GAMES[game].fetchLatest();
  await Mutex.runExclusive(`patchbot:${guild.id}:${game}`, () => sendUpdate(client, guild, channel, config, game, patch));
  return patch;
}
