// Runtime-only, read-only status of Cloudy's existing Discord channel links.
// Does not fetch message histories or mutate Discord, embeds, tickets or data.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from './cloudyChannelResolver.js';

const TARGET_KEYS = Object.freeze([
  'rustPatch', 'nitradoPatch', 'zorp', 'rules', 'terms', 'termsOfSale',
  'privacy', 'faq', 'welcome', 'announcements', 'appeal', 'reports',
  'ticketLogs', 'ticketTranscripts', 'joinToCreate', 'contactSupport',
  'security', 'staffList', 'botCommands', 'botlog', 'staffReviews',
  'postedReviews', 'giveaway', 'youtube', 'twitch', 'tiktok',
]);
const PATCH_KEYS = new Set(['rustPatch', 'nitradoPatch']);

function textChannel(channel) {
  return channel?.type === ChannelType.GuildText
    || channel?.type === ChannelType.GuildAnnouncement;
}

function has(channel, member, permission) {
  try { return Boolean(channel?.permissionsFor(member)?.has(permission)); }
  catch { return false; }
}

function resolveFromCache(guild, key) {
  const definition = getCloudyChannelDefinition(key);
  if (!definition) return null;
  const legacy = guild.channels.cache.get(definition.legacyId);
  if (textChannel(legacy)) return legacy;
  return findCloudyChannelByAlias(guild, definition.aliases || [], { textOnly: true });
}

export function inspectCloudyChannelLinks(guild, member) {
  if (!guild?.channels?.cache || !member) return null;
  const channels = [...guild.channels.cache.values()];
  const text = channels.filter(textChannel);
  const readable = text.filter(channel =>
    has(channel, member, PermissionFlagsBits.ViewChannel)
    && has(channel, member, PermissionFlagsBits.ReadMessageHistory));
  const links = {};
  for (const key of TARGET_KEYS) {
    const channel = resolveFromCache(guild, key);
    const found = Boolean(channel);
    const view = found && has(channel, member, PermissionFlagsBits.ViewChannel);
    const history = found && has(channel, member, PermissionFlagsBits.ReadMessageHistory);
    const send = found && has(channel, member, PermissionFlagsBits.SendMessages);
    const embed = found && has(channel, member, PermissionFlagsBits.EmbedLinks);
    const neededPost = PATCH_KEYS.has(key);
    const ok = found && view && history && (!neededPost || (send && embed));
    links[key] = {
      found,
      id: channel?.id || null,
      name: channel?.name || null,
      view, history, send, embed,
      ok,
    };
  }
  return {
    guildId: guild.id,
    totalChannels: channels.length,
    textChannels: text.length,
    readableTextChannels: readable.length,
    unreadableTextChannels: text.length - readable.length,
    links,
  };
}

export function formatCloudyChannelAudit(audit) {
  if (!audit) return 'not available: guild member or channel inventory missing';
  const important = ['rustPatch', 'nitradoPatch', 'zorp', 'reports', 'faq', 'ticketLogs', 'ticketTranscripts'];
  const statuses = important.map(key => {
    const link = audit.links[key];
    return key + '=' + (!link.found ? 'missing' : !link.ok ? 'permissions' : 'ok');
  });
  const otherMissing = Object.entries(audit.links).filter(
    ([key, value]) => !important.includes(key) && !value.found,
  ).map(([key]) => key);
  return 'guild=' + audit.guildId + ' visible_text=' + audit.readableTextChannels + '/' + audit.textChannels
    + ' inaccessible_text=' + audit.unreadableTextChannels + '; ' + statuses.join(', ')
    + '; other_unresolved=' + (otherMissing.length ? otherMissing.join(',') : 'none');
}
