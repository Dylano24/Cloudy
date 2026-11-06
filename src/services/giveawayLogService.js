// Giveaway created, ended and winner country logs in #giveaway-logs, styled
// like the claim logs (Cloudy logo, footer). They are complete when sent.
import { logger } from '../utils/logger.js';
import { CLOUDY_C_LOGO_URL, giveawayEndTime, giveawayParticipants } from './giveawayService.js';
import { GIVEAWAY_CLAIM_LOG_CHANNEL_ID, GIVEAWAY_CLAIM_LOG_FOOTER } from './giveawayClaimLogService.js';
import { getOrCreateGiveawayNumber } from './giveawayNumberService.js';
import { giveawayCodeLabel, requiresCountry } from './giveawayCodeService.js';
import { findCloudyChannelByAlias } from './cloudyChannelResolver.js';
import { findCloudyOwnerRole } from './ownerRoleAccess.js';

const GIVEAWAY_LOG_ALIASES = ['giveaway-logs', 'giveaway-log'];
const unix = value => Math.floor((Number.isFinite(value) ? value : Date.now()) / 1000);
const validId = value => /^\d{17,20}$/.test(String(value || ''));

// The winner country log has its own channel (owner's choice), not #giveaway-logs.
export const GIVEAWAY_COUNTRY_LOG_CHANNEL_ID = '1567403416890642493';

async function countryLogChannel(guild) {
  const own = guild?.channels?.cache?.get?.(GIVEAWAY_COUNTRY_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_COUNTRY_LOG_CHANNEL_ID).catch(() => null);
  return own?.send ? own : giveawayLogChannel(guild);
}

async function giveawayLogChannel(guild) {
  const named = findCloudyChannelByAlias(guild, GIVEAWAY_LOG_ALIASES, { textOnly: true });
  if (named?.send) return named;
  const fallback = guild?.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID).catch(() => null);
  return fallback?.send ? fallback : null;
}

function giveawayLink(guildId, giveaway, number) {
  const label = number ? '#' + number : 'Go to giveaway';
  return validId(giveaway?.channelId) && validId(giveaway?.messageId)
    ? `[${label}](https://discord.com/channels/${guildId}/${giveaway.channelId}/${giveaway.messageId})`
    : label;
}

const field = (name, value) => ({ name, value: String(value || 'Not specified').slice(0, 1024), inline: false });

function logEmbed(title, color, fields) {
  return {
    title,
    color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    fields,
    footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER },
  };
}

export function buildGiveawayCreatedLog(guildId, giveaway, number = null) {
  return {
    embeds: [logEmbed('Giveaway created', 0x00C49D, [
      field('Giveaway', giveawayLink(guildId, giveaway, number)),
      field('Prize', giveaway.prize),
      field('Hosted by', giveaway.hostId ? `<@${giveaway.hostId}>` : null),
      field('Channel', validId(giveaway.channelId) ? `<#${giveaway.channelId}>` : null),
      field('Winners', String(Number(giveaway.winnerCount) || 1)),
      field('Code', giveawayCodeLabel(giveaway)),
      field('Ends', `<t:${unix(giveawayEndTime(giveaway))}:F>`),
      field('Date', `<t:${unix(Date.parse(giveaway.createdAt))}:F>`),
    ])],
    allowedMentions: { parse: [] },
  };
}

export function buildGiveawayEndedLog(guildId, giveaway, winners = [], number = null) {
  const endedBy = giveaway.endedBy && giveaway.endedBy !== 'automatic' ? `<@${giveaway.endedBy}>` : 'Automatic';
  return {
    embeds: [logEmbed('Giveaway ended', 0xFFFFFF, [
      field('Giveaway', giveawayLink(guildId, giveaway, number)),
      field('Prize', giveaway.prize),
      field('Ended by', endedBy),
      field('Participants', String(giveawayParticipants(giveaway).length)),
      field('Winners', winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid entries'),
      field('Date', `<t:${unix(Date.parse(giveaway.endedAt))}:F>`),
    ])],
    allowedMentions: { parse: [] },
  };
}

// Winners only; the Owner role is tagged (owner's choice).
export function buildGiveawayWinnerCountryLog(guildId, giveaway, winners = [], { number = null, ownerRoleId = null } = {}) {
  const countries = giveaway.participantCountries || {};
  return {
    ...(ownerRoleId ? { content: `<@&${ownerRoleId}>` } : {}),
    embeds: [logEmbed('Giveaway winner country', 0xFFFFFF, [
      field('Giveaway', giveawayLink(guildId, giveaway, number)),
      field('Prize', giveaway.prize),
      field(winners.length === 1 ? 'Winner' : 'Winners',
        winners.map(id => `<@${id}>: ${countries[id] || 'Not provided'}`).join('\n')),
      field('Date', `<t:${unix(Date.now())}:F>`),
    ])],
    allowedMentions: { parse: [], roles: ownerRoleId ? [ownerRoleId] : [] },
  };
}

async function numberFor(client, guild, giveaway) {
  if (Number.isSafeInteger(giveaway?.giveawayNumber) && giveaway.giveawayNumber > 0) return giveaway.giveawayNumber;
  return getOrCreateGiveawayNumber(client, guild.id, giveaway.messageId).catch(() => null);
}

// Logs never stop a giveaway action; a failure is only written to the logs.
async function send(guild, build, label, findChannel = giveawayLogChannel) {
  try {
    const channel = await findChannel(guild);
    if (!channel) throw new Error('#giveaway-logs is unavailable');
    return await channel.send(await build());
  } catch (error) {
    logger.warn(`Could not send giveaway ${label} log: ${error?.message || error}`);
    return null;
  }
}

export function sendGiveawayCreatedLog(client, guild, giveaway) {
  return send(guild, async () => buildGiveawayCreatedLog(guild.id, giveaway, await numberFor(client, guild, giveaway)), 'created');
}

export function sendGiveawayEndedLog(client, guild, giveaway, winners) {
  return send(guild, async () => buildGiveawayEndedLog(guild.id, giveaway, winners, await numberFor(client, guild, giveaway)), 'ended');
}

export function sendGiveawayWinnerCountryLog(client, guild, giveaway, winners) {
  if (!requiresCountry(giveaway) || !winners?.length) return Promise.resolve(null);
  return send(guild, async () => buildGiveawayWinnerCountryLog(guild.id, giveaway, winners, {
    number: await numberFor(client, guild, giveaway),
    ownerRoleId: findCloudyOwnerRole(guild)?.id || null,
  }), 'winner country', countryLogChannel);
}
