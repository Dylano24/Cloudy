import {
  AuditLogEvent,
  EmbedBuilder,
  PermissionFlagsBits,
  UserFlagsBitField,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const CONFIG_PREFIX = 'security:config:';
const QUARANTINE_PREFIX = 'security:quarantine:';
const BACKUP_PREFIX = 'security:backups:';
const MAX_BACKUPS = 5;
const RUNTIME_WINDOW_MS = 60 * 60_000;
const actionWindows = new Map();
const messageHeat = new Map();

const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
];

export const SECURITY_ACTIONS = ['log', 'timeout', 'kick', 'ban', 'quarantine'];

export const DEFAULT_SECURITY_CONFIG = Object.freeze({
  logChannelId: null,
  panic: false,
  trustedUsers: [],
  trustedRoles: [],
  antiNuke: {
    enabled: true,
    action: 'log',
    minuteLimit: 5,
    hourLimit: 15,
    includeBots: true,
  },
  joinGate: {
    enabled: false,
    action: 'log',
    minimumAccountAgeDays: 0,
    noAvatar: false,
    unauthorizedBots: true,
    unverifiedBots: false,
    advertisingNames: false,
    blockedNamePatterns: [],
  },
  antiSpam: {
    enabled: true,
    action: 'timeout',
    windowSeconds: 10,
    messageLimit: 8,
    duplicateLimit: 4,
    mentionLimit: 8,
    capsPercent: 85,
    timeoutMinutes: 10,
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, incoming) {
  const result = clone(base);
  for (const [key, value] of Object.entries(incoming || {})) {
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function configKey(guildId) {
  return `${CONFIG_PREFIX}${guildId}`;
}

function quarantineKey(guildId) {
  return `${QUARANTINE_PREFIX}${guildId}`;
}

function backupKey(guildId) {
  return `${BACKUP_PREFIX}${guildId}`;
}

export async function getSecurityConfig(client, guildId) {
  const stored = await client.db?.get?.(configKey(guildId), null);
  return deepMerge(DEFAULT_SECURITY_CONFIG, stored || {});
}

export async function saveSecurityConfig(client, guildId, patch) {
  const current = await getSecurityConfig(client, guildId);
  const merged = deepMerge(current, patch || {});

  merged.trustedUsers = [...new Set((merged.trustedUsers || []).map(String))];
  merged.trustedRoles = [...new Set((merged.trustedRoles || []).map(String))];
  merged.antiNuke.minuteLimit = Math.max(1, Math.min(100, Number(merged.antiNuke.minuteLimit || 5)));
  merged.antiNuke.hourLimit = Math.max(1, Math.min(500, Number(merged.antiNuke.hourLimit || 15)));
  if (!SECURITY_ACTIONS.includes(merged.antiNuke.action)) merged.antiNuke.action = 'log';
  if (!SECURITY_ACTIONS.includes(merged.joinGate.action)) merged.joinGate.action = 'log';
  if (!SECURITY_ACTIONS.includes(merged.antiSpam.action)) merged.antiSpam.action = 'timeout';

  await client.db?.set?.(configKey(guildId), merged);
  return merged;
}

export function memberIsTrusted(member, config) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  if ((config.trustedUsers || []).includes(member.id)) return true;
  return member.roles?.cache?.some((role) => (config.trustedRoles || []).includes(role.id)) || false;
}

async function sendSecurityAlert(guild, config, {
  title,
  description,
  severity = 'warning',
  fields = [],
}) {
  const color = severity === 'critical' ? 0xED4245 : severity === 'success' ? 0x57F287 : 0xFEE75C;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(String(description || '').slice(0, 3500))
    .setColor(color)
    .addFields(fields.slice(0, 25))
    .setTimestamp();

  let channel = null;
  if (config.logChannelId) {
    channel = guild.channels.cache.get(config.logChannelId)
      || await guild.channels.fetch(config.logChannelId).catch(() => null);
  }
  if (!channel?.isTextBased?.()) channel = guild.systemChannel;

  if (channel?.isTextBased?.()) {
    await channel.send({ embeds: [embed] }).catch((error) =>
      logger.warn(`Security alert could not be sent in ${guild.id}: ${error?.message || error}`)
    );
  }
}

function actionKey(guildId, userId, type) {
  return `${guildId}:${userId}:${type}`;
}

function recordAction(guildId, userId, type) {
  const key = actionKey(guildId, userId, type);
  const now = Date.now();
  const entries = (actionWindows.get(key) || []).filter((timestamp) => now - timestamp < RUNTIME_WINDOW_MS);
  entries.push(now);
  actionWindows.set(key, entries);

  if (actionWindows.size > 10_000) {
    for (const [entryKey, timestamps] of actionWindows.entries()) {
      if (!timestamps.some((timestamp) => now - timestamp < RUNTIME_WINDOW_MS)) {
        actionWindows.delete(entryKey);
      }
    }
  }

  return {
    minute: entries.filter((timestamp) => now - timestamp < 60_000).length,
    hour: entries.length,
  };
}

async function saveQuarantineRecord(client, guildId, userId, record) {
  const records = await client.db?.get?.(quarantineKey(guildId), {});
  const normalized = records && typeof records === 'object' ? records : {};
  normalized[userId] = record;
  await client.db?.set?.(quarantineKey(guildId), normalized);
}

export async function getQuarantineRecords(client, guildId) {
  const records = await client.db?.get?.(quarantineKey(guildId), {});
  return records && typeof records === 'object' ? records : {};
}

async function quarantineMember(member, reason) {
  const removableRoles = member.roles.cache.filter((role) =>
    role.id !== member.guild.id
    && !role.managed
    && role.editable
    && DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission))
  );

  const removedRoleIds = [...removableRoles.keys()];
  for (const role of removableRoles.values()) {
    await member.roles.remove(role, `Cloudy security quarantine: ${reason}`).catch(() => {});
  }

  if (member.moderatable) {
    await member.timeout(24 * 60 * 60_000, `Cloudy security quarantine: ${reason}`).catch(() => {});
  }

  await saveQuarantineRecord(member.client, member.guild.id, member.id, {
    userId: member.id,
    removedRoleIds,
    reason,
    quarantinedAt: new Date().toISOString(),
  });

  return removedRoleIds;
}

export async function releaseQuarantine(client, guild, userId) {
  const records = await getQuarantineRecords(client, guild.id);
  const record = records[userId];
  if (!record) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    if (member.isCommunicationDisabled?.()) {
      await member.timeout(null, 'Cloudy security quarantine released').catch(() => {});
    }

    for (const roleId of record.removedRoleIds || []) {
      const role = guild.roles.cache.get(roleId);
      if (role?.editable) await member.roles.add(role, 'Cloudy security quarantine released').catch(() => {});
    }
  }

  delete records[userId];
  await client.db?.set?.(quarantineKey(guild.id), records);
  return true;
}

async function applyMemberAction(member, action, reason, { timeoutMs = 60 * 60_000 } = {}) {
  if (!member || action === 'log') return { applied: 'log' };

  if (action === 'timeout') {
    if (!member.moderatable) return { applied: 'log', failed: 'Member cannot be timed out' };
    await member.timeout(timeoutMs, reason);
    return { applied: 'timeout' };
  }
  if (action === 'kick') {
    if (!member.kickable) return { applied: 'log', failed: 'Member cannot be kicked' };
    await member.kick(reason);
    return { applied: 'kick' };
  }
  if (action === 'ban') {
    if (!member.bannable) return { applied: 'log', failed: 'Member cannot be banned' };
    await member.ban({ reason });
    return { applied: 'ban' };
  }
  if (action === 'quarantine') {
    const removedRoleIds = await quarantineMember(member, reason);
    return { applied: 'quarantine', removedRoleIds };
  }

  return { applied: 'log' };
}

export async function processAntiNukeAuditEvent(guild, {
  auditType,
  actionType,
  targetId = null,
  targetLabel = null,
  delayMs = 800,
}) {
  const config = await getSecurityConfig(guild.client, guild.id);
  if (!config.antiNuke.enabled) return null;

  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));

  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 8 }).catch(() => null);
  if (!logs) return null;

  const now = Date.now();
  const entry = logs.entries.find((candidate) =>
    (!targetId || candidate.target?.id === targetId)
    && now - candidate.createdTimestamp < 15_000
  );
  if (!entry?.executor || entry.executor.id === guild.client.user?.id) return null;

  const executorMember = await guild.members.fetch(entry.executor.id).catch(() => null);
  if (executorMember && memberIsTrusted(executorMember, config)) return null;
  if (entry.executor.bot && !config.antiNuke.includeBots) return null;

  const counts = recordAction(guild.id, entry.executor.id, actionType);
  const breached = counts.minute >= config.antiNuke.minuteLimit || counts.hour >= config.antiNuke.hourLimit;

  if (!breached) return { entry, counts, breached: false };

  const reason = `Anti-nuke threshold reached for ${actionType} (${counts.minute}/min, ${counts.hour}/hour)`;
  const result = executorMember
    ? await applyMemberAction(executorMember, config.antiNuke.action, reason)
    : { applied: 'log', failed: 'Executor is no longer in the server' };

  await sendSecurityAlert(guild, config, {
    title: '🚨 Anti-Nuke Triggered',
    description: `${entry.executor} triggered the **${actionType}** threshold.`,
    severity: 'critical',
    fields: [
      { name: 'Executor', value: `${entry.executor.tag} (${entry.executor.id})`, inline: false },
      { name: 'Target', value: targetLabel || targetId || 'Unknown', inline: false },
      { name: 'Rate', value: `${counts.minute}/minute • ${counts.hour}/hour`, inline: true },
      { name: 'Response', value: result.applied, inline: true },
      { name: 'Reason', value: entry.reason || 'No audit-log reason', inline: false },
    ],
  });

  return { entry, counts, breached: true, result };
}

function accountAgeDays(user) {
  return (Date.now() - user.createdTimestamp) / (24 * 60 * 60_000);
}

function hasAvatar(user) {
  return Boolean(user.avatar || user.avatarDecorationData);
}

function isVerifiedBot(user) {
  if (!user.bot) return true;
  return user.flags?.has?.(UserFlagsBitField.Flags.VerifiedBot) || false;
}

function nameLooksLikeAdvertising(user, patterns = []) {
  const name = `${user.username || ''} ${user.globalName || ''}`.toLowerCase();
  const builtIn = /(discord\.?gg|discord\.com|invite|\.gg\b|free\s*nitro|cheap\s*nitro)/i.test(name);
  if (builtIn) return true;

  return (patterns || []).some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(name);
    } catch {
      return name.includes(String(pattern).toLowerCase());
    }
  });
}

async function resolveBotAdder(member) {
  if (!member.user.bot) return null;
  await new Promise((resolve) => setTimeout(resolve, 800));
  const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 6 }).catch(() => null);
  const now = Date.now();
  return logs?.entries.find((entry) =>
    entry.target?.id === member.id && now - entry.createdTimestamp < 15_000
  ) || null;
}

export async function enforceJoinGate(member) {
  const config = await getSecurityConfig(member.client, member.guild.id);
  const gate = config.joinGate;
  if (!gate.enabled && !config.panic) return false;

  const triggers = [];
  const age = accountAgeDays(member.user);

  if (config.panic) triggers.push('Panic mode: joins are restricted');
  if (gate.minimumAccountAgeDays > 0 && age < gate.minimumAccountAgeDays) {
    triggers.push(`Account age ${age.toFixed(1)}d is below ${gate.minimumAccountAgeDays}d`);
  }
  if (gate.noAvatar && !hasAvatar(member.user)) triggers.push('Account has no custom avatar');
  if (gate.unverifiedBots && member.user.bot && !isVerifiedBot(member.user)) {
    triggers.push('Bot is not Discord-verified');
  }
  if (gate.advertisingNames && nameLooksLikeAdvertising(member.user, gate.blockedNamePatterns)) {
    triggers.push('Username/global name matched advertising or blocked pattern');
  }

  let botAdder = null;
  if (gate.unauthorizedBots && member.user.bot) {
    botAdder = await resolveBotAdder(member);
    const adderMember = botAdder?.executor
      ? await member.guild.members.fetch(botAdder.executor.id).catch(() => null)
      : null;
    if (!adderMember || !memberIsTrusted(adderMember, config)) {
      triggers.push(`Bot was added by an unauthorized user${botAdder?.executor ? ` (${botAdder.executor.tag})` : ''}`);
    }
  }

  if (!triggers.length) return false;

  const reason = `Join Gate: ${triggers.join('; ')}`.slice(0, 480);
  let action = config.panic ? 'kick' : gate.action;
  if (member.user.bot && action === 'timeout') action = 'kick';
  if (member.user.bot && action === 'quarantine') action = 'kick';

  const result = await applyMemberAction(member, action, reason, { timeoutMs: 60 * 60_000 });

  await sendSecurityAlert(member.guild, config, {
    title: '🛡️ Join Gate Triggered',
    description: `${member.user} matched one or more Join Gate filters.`,
    severity: result.applied === 'log' ? 'warning' : 'critical',
    fields: [
      { name: 'Account', value: `${member.user.tag} (${member.user.id})`, inline: false },
      { name: 'Account Age', value: `${age.toFixed(1)} days`, inline: true },
      { name: 'Response', value: result.applied, inline: true },
      { name: 'Triggers', value: triggers.map((trigger) => `• ${trigger}`).join('\n').slice(0, 1000), inline: false },
    ],
  });

  return result.applied !== 'log';
}

function getMessageHeatKey(message) {
  return `${message.guild.id}:${message.author.id}`;
}

function calculateCapsPercent(content) {
  const letters = String(content || '').match(/[a-z]/gi) || [];
  if (letters.length < 8) return 0;
  const upper = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return (upper / letters.length) * 100;
}

export async function enforceAntiSpam(message) {
  if (!message.guild || message.author.bot) return false;
  const config = await getSecurityConfig(message.client, message.guild.id);
  const spam = config.antiSpam;
  if (!spam.enabled) return false;
  if (memberIsTrusted(message.member, config)) return false;

  const key = getMessageHeatKey(message);
  const now = Date.now();
  const windowMs = Math.max(2, Number(spam.windowSeconds || 10)) * 1000;
  const recent = (messageHeat.get(key) || []).filter((entry) => now - entry.time < windowMs);
  const normalizedContent = String(message.content || '').trim().toLowerCase().replace(/\s+/g, ' ');

  recent.push({ time: now, content: normalizedContent });
  messageHeat.set(key, recent);

  const duplicateCount = normalizedContent
    ? recent.filter((entry) => entry.content === normalizedContent).length
    : 0;
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  const capsPercent = calculateCapsPercent(message.content);

  const triggers = [];
  if (recent.length >= Number(spam.messageLimit || 8)) triggers.push(`${recent.length} messages in ${spam.windowSeconds}s`);
  if (duplicateCount >= Number(spam.duplicateLimit || 4)) triggers.push(`${duplicateCount} duplicate messages`);
  if (mentionCount >= Number(spam.mentionLimit || 8)) triggers.push(`${mentionCount} mentions`);
  if (capsPercent >= Number(spam.capsPercent || 85)) triggers.push(`${capsPercent.toFixed(0)}% caps`);

  if (!triggers.length) return false;

  await message.delete().catch(() => {});
  const reason = `Anti-spam: ${triggers.join(', ')}`;
  const result = await applyMemberAction(message.member, spam.action, reason, {
    timeoutMs: Math.max(1, Number(spam.timeoutMinutes || 10)) * 60_000,
  });

  await sendSecurityAlert(message.guild, config, {
    title: '⚠️ Anti-Spam Triggered',
    description: `${message.author} triggered Cloudy anti-spam.`,
    severity: result.applied === 'log' ? 'warning' : 'critical',
    fields: [
      { name: 'Triggers', value: triggers.join('\n'), inline: false },
      { name: 'Response', value: result.applied, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
    ],
  });

  return true;
}

export async function createSecurityBackup(client, guild) {
  const stored = await client.db?.get?.(backupKey(guild.id), []);
  const backups = Array.isArray(stored) ? stored : [];

  const backup = {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    createdAt: new Date().toISOString(),
    guildName: guild.name,
    roles: guild.roles.cache
      .filter((role) => !role.managed && role.id !== guild.id)
      .sort((a, b) => a.position - b.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
      })),
    channels: guild.channels.cache
      .filter((channel) => !channel.isThread?.())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId || null,
        position: channel.position,
        topic: 'topic' in channel ? channel.topic : null,
        nsfw: 'nsfw' in channel ? channel.nsfw : false,
      })),
  };

  backups.unshift(backup);
  await client.db?.set?.(backupKey(guild.id), backups.slice(0, MAX_BACKUPS));
  return backup;
}

export async function getSecurityBackups(client, guildId) {
  const stored = await client.db?.get?.(backupKey(guildId), []);
  return Array.isArray(stored) ? stored : [];
}

export async function restoreSecurityBackup(client, guild, backupId) {
  const backups = await getSecurityBackups(client, guild.id);
  const backup = backups.find((entry) => String(entry.id).toUpperCase() === String(backupId).toUpperCase());
  if (!backup) throw new Error('Security backup not found.');

  const createdRoles = [];
  for (const saved of backup.roles || []) {
    if (guild.roles.cache.some((role) => role.name === saved.name)) continue;
    try {
      const role = await guild.roles.create({
        name: saved.name,
        color: saved.color,
        hoist: saved.hoist,
        mentionable: saved.mentionable,
        permissions: BigInt(saved.permissions || '0'),
        reason: `Cloudy backup ${backup.id} restore`,
      });
      createdRoles.push(role.id);
    } catch (error) {
      logger.warn(`Backup restore could not recreate role ${saved.name}: ${error?.message || error}`);
    }
  }

  // Channel restore is intentionally conservative: create missing channels by
  // name/type only. Existing channels are never deleted or overwritten.
  const createdChannels = [];
  for (const saved of backup.channels || []) {
    if (guild.channels.cache.some((channel) => channel.name === saved.name && channel.type === saved.type)) continue;
    try {
      const channel = await guild.channels.create({
        name: saved.name,
        type: saved.type,
        topic: saved.topic || undefined,
        nsfw: saved.nsfw || false,
        reason: `Cloudy backup ${backup.id} restore`,
      });
      createdChannels.push(channel.id);
    } catch (error) {
      logger.warn(`Backup restore could not recreate channel ${saved.name}: ${error?.message || error}`);
    }
  }

  return { backup, createdRoles, createdChannels };
}

export { AuditLogEvent };
