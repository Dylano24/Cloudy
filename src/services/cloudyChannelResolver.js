import { ChannelType } from 'discord.js';

const CHANNELS = Object.freeze({
  rules: { legacyId: '1533189582064062564', aliases: ['rules'] },
  terms: { legacyId: '1533191366190829768', aliases: ['terms-of-services', 'termes-of-services', 'terms-of-service'] },
  termsOfSale: { legacyId: '1534786470790037665', aliases: ['terms-of-sale', 'store-terms'] },
  privacy: { legacyId: '1533188744562344016', aliases: ['privacy-policy'] },
  shop: { legacyId: '1533192856909512774', aliases: ['shop'] },
  gambling: { legacyId: '1533188412507558130', aliases: ['gambling'] },
  rustPatch: { legacyId: '1533886914459861103', aliases: ['patch-notes', 'rust-patch-notes'] },
  nitradoPatch: { legacyId: '1539397467647377530', aliases: ['nitrado-patch-notes', 'nitrado-updates'] },
  faq: { legacyId: '1534654577385672917', aliases: ['faq'] },
  zorp: { legacyId: '1533212973034770462', aliases: ['zorp-off-raid-protection'] },
  staffList: { legacyId: '1533198028733939722', aliases: ['staff-list'] },
  contactSupport: { legacyId: '1533197784725852181', aliases: ['contact-support', 'contact-us'] },
  security: { legacyId: '1533197569495142551', aliases: ['security-information'] },
  appeal: { legacyId: '1539407865318477844', aliases: ['appeal-form'] },
  staffReviews: { legacyId: '1533965979682476082', aliases: ['staff-reviews'] },
  postedReviews: { legacyId: '1540625438601379961', aliases: ['posted-reviews'] },
  inviteLogs: { legacyId: '1539371572442435646', aliases: ['invitation-logs'] },
  kickLogs: { legacyId: '1539375620885323826', aliases: ['kick-logs'] },
  timeoutLogs: { legacyId: '1539371111240831078', aliases: ['timeout-logs'] },
  banLogs: { legacyId: '1539259457404412036', aliases: ['ban-logs'] },
  reports: { legacyId: '1539372511089926244', aliases: ['reports'] },
  ticketLogs: { aliases: ['ticket-logs'] },
  ticketTranscripts: { aliases: ['ticket-transcripts'] },
  welcome: { aliases: ['welcome'] },
  settings: { aliases: ['settings'] },
  wipes: { aliases: ['wipes'] },
  restart: { aliases: ['restart', 'server-restart'] },
  population: { aliases: ['population', 'server-population'] },
  announcements: { aliases: ['announcements'] },
  nextWipe: { aliases: ['next-wipe'] },
  serverStatus: { aliases: ['server-status'] },
  votes: { aliases: ['votes'] },
  vip: { aliases: ['vip'] },
  queueSkip: { aliases: ['queue-skip'] },
  contentCreator: { aliases: ['content-creator'] },
  officialStore: { aliases: ['cloudy-official-store'] },
  leaderboard: { aliases: ['leaderboard'] },
  giveaway: { aliases: ['giveaway'] },
  boost: { aliases: ['boost'] },
  tipJar: { aliases: ['tip-jar'] },
  general: { aliases: ['general'] },
  media: { aliases: ['media'] },
  teamUp: { aliases: ['team-up'] },
  suggestions: { aliases: ['suggestions'] },
  youtube: { aliases: ['youtube'] },
  twitch: { aliases: ['twitch'] },
  tiktok: { aliases: ['tiktok'] },
  informations: { aliases: ['informations'] },
  botCommands: { aliases: ['bot-commands'] },
  banTimeoutAppeals: { aliases: ['ban-timeout-appeals'] },
  joinToCreate: { aliases: ['join-for-create-set-it-up', 'join-for-create-and-set-it-up'] },
});

function normalize(value = '') {
  const raw = String(value).trim().toLowerCase();
  const afterSeparator = raw.includes('│') ? raw.split('│').at(-1) : raw;
  return afterSeparator
    .normalize('NFKD')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function channelMatches(channel, aliases = []) {
  if (!channel) return false;
  const normalizedName = normalize(channel.name);
  return aliases.some(alias => normalizedName === normalize(alias));
}

export function getCloudyChannelDefinition(key) {
  return CHANNELS[key] || null;
}

export async function resolveCloudyChannel(client, key, { guild = null, textOnly = false, voiceOnly = false } = {}) {
  const definition = CHANNELS[key];
  if (!definition || !client) return null;

  if (definition.legacyId) {
    const legacy = client.channels.cache.get(definition.legacyId)
      || await client.channels.fetch(definition.legacyId).catch(() => null);
    if (legacy) return legacy;
  }

  let targetGuild = guild;
  if (!targetGuild) {
    const configuredGuildId = String(process.env.GUILD_ID || '').trim();
    if (configuredGuildId) {
      targetGuild = client.guilds.cache.get(configuredGuildId)
        || await client.guilds.fetch(configuredGuildId).catch(() => null);
    }
  }

  if (!targetGuild && client.guilds.cache.size === 1) {
    targetGuild = client.guilds.cache.first();
  }
  if (!targetGuild) return null;

  await targetGuild.channels.fetch().catch(() => null);

  const candidates = [...targetGuild.channels.cache.values()].filter(channel => {
    if (channel.type === ChannelType.GuildCategory) return false;
    if (textOnly && !channel.isTextBased?.()) return false;
    if (voiceOnly && channel.type !== ChannelType.GuildVoice) return false;
    return channelMatches(channel, definition.aliases || []);
  });

  return candidates.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))[0] || null;
}

export function findCloudyChannelByAlias(guild, aliases, { textOnly = false, voiceOnly = false } = {}) {
  if (!guild) return null;
  return [...guild.channels.cache.values()]
    .filter(channel => {
      if (channel.type === ChannelType.GuildCategory) return false;
      if (textOnly && !channel.isTextBased?.()) return false;
      if (voiceOnly && channel.type !== ChannelType.GuildVoice) return false;
      return channelMatches(channel, aliases);
    })
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))[0] || null;
}

export { normalize as normalizeCloudyChannelName };
