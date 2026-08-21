import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getGuildTicketStats } from '../utils/database.js';

const CHECK_TIMEOUT_MS = 2500;

const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
]);

function withTimeout(promise, timeoutMs = CHECK_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function makeCheck(id, label, status, detail, fix = null) {
  return { id, label, status, detail, fix };
}

function permissionNames(permissions, required) {
  if (!permissions) return required.map(permission => PERMISSION_LABELS.get(permission) || String(permission));
  return required
    .filter(permission => !permissions.has(permission))
    .map(permission => PERMISSION_LABELS.get(permission) || String(permission));
}

async function fetchChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
}

async function fetchRole(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.cache.get(roleId)
    || await guild.roles.fetch(roleId).catch(() => null);
}

function hasCreateTicketButton(message) {
  return Boolean(message?.components?.some(row =>
    row.components?.some(component => component.customId === 'create_ticket')
  ));
}

async function checkTextDestination({ guild, botMember, channelId, label, attachments = false, required = true }) {
  if (!channelId) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      required ? 'warning' : 'info',
      'Not configured.',
      required ? `Configure ${label.toLowerCase()} in /ticket dashboard.` : null,
    );
  }

  const channel = await fetchChannel(guild, channelId);
  if (!channel) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      'critical',
      `Configured channel ${channelId} no longer exists.`,
      `Choose a new ${label.toLowerCase()} in /ticket dashboard.`,
    );
  }

  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !channel.isSendable?.()) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      'critical',
      `<#${channel.id}> is not a sendable text channel.`,
      `Choose a normal text channel for ${label.toLowerCase()}.`,
    );
  }

  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    ...(attachments ? [PermissionFlagsBits.AttachFiles] : []),
  ];
  const missing = permissionNames(channel.permissionsFor(botMember), requiredPermissions);

  if (missing.length > 0) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      'critical',
      `<#${channel.id}> is missing: ${missing.join(', ')}.`,
      `Give Cloudy ${missing.join(', ')} in <#${channel.id}>.`,
    );
  }

  return makeCheck(
    label.toLowerCase().replace(/\s+/g, '_'),
    label,
    'healthy',
    `<#${channel.id}> is usable.`,
  );
}

async function checkCategory(guild, botMember, channelId, label, { required = false } = {}) {
  if (!channelId) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      required ? 'warning' : 'info',
      required ? 'Not configured; Cloudy will fall back to its default Tickets category.' : 'Not configured.',
      required ? `Configure ${label.toLowerCase()} in /ticket dashboard for deterministic placement.` : null,
    );
  }

  const category = await fetchChannel(guild, channelId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      'critical',
      `Configured category ${channelId} no longer exists or is not a category.`,
      `Choose a valid ${label.toLowerCase()} in /ticket dashboard.`,
    );
  }

  const missing = permissionNames(
    category.permissionsFor(botMember),
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
  );

  if (missing.length > 0) {
    return makeCheck(
      label.toLowerCase().replace(/\s+/g, '_'),
      label,
      'critical',
      `<#${category.id}> is missing: ${missing.join(', ')}.`,
      `Give Cloudy ${missing.join(', ')} on the category.`,
    );
  }

  return makeCheck(
    label.toLowerCase().replace(/\s+/g, '_'),
    label,
    'healthy',
    `<#${category.id}> is usable.`,
  );
}

async function checkDatabase(client) {
  const status = client?.db?.getStatus?.() || {};
  const degraded = client?.db?.isDegraded?.() === true || status.isDegraded === true;
  const available = typeof client?.db?.isAvailable === 'function'
    ? client.db.isAvailable()
    : Boolean(client?.db);

  if (!available || degraded) {
    return makeCheck(
      'database',
      'PostgreSQL',
      'critical',
      `Persistent database unavailable${status.degradedReason ? ` (${status.degradedReason})` : ''}.`,
      'Restore the Railway PostgreSQL connection before changing or creating tickets.',
    );
  }

  const pool = client?.db?.db?.pool;
  if (pool?.query) {
    try {
      const started = Date.now();
      await withTimeout(pool.query('SELECT 1'));
      return makeCheck('database', 'PostgreSQL', 'healthy', `Connected • ${Date.now() - started}ms query.`);
    } catch (error) {
      return makeCheck('database', 'PostgreSQL', 'critical', `Connection check failed: ${error.message}`, 'Check the Railway PostgreSQL service and DATABASE_URL.');
    }
  }

  return makeCheck('database', 'PostgreSQL', 'healthy', 'Persistent database reports available.');
}

async function checkPanel(client, guild, botMember, config) {
  if (!config.ticketPanelChannelId) {
    return makeCheck('panel', 'Ticket Panel', 'critical', 'No ticket panel channel is configured.', 'Run /ticket setup.');
  }

  const channel = await fetchChannel(guild, config.ticketPanelChannelId);
  if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) {
    return makeCheck('panel', 'Ticket Panel', 'critical', 'Configured panel channel is missing or invalid.', 'Choose a new panel channel in /ticket dashboard.');
  }

  const missing = permissionNames(
    channel.permissionsFor(botMember),
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
  );
  if (missing.length > 0) {
    return makeCheck('panel', 'Ticket Panel', 'critical', `<#${channel.id}> is missing: ${missing.join(', ')}.`, `Give Cloudy ${missing.join(', ')} in the panel channel.`);
  }

  let panel = null;
  if (config.ticketPanelMessageId) {
    panel = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
  }
  if (!panel) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    panel = recent?.find(message => message.author?.id === client.user?.id && hasCreateTicketButton(message)) || null;
  }

  if (!panel) {
    return makeCheck('panel', 'Ticket Panel', 'critical', `No live Cloudy ticket panel was found in <#${channel.id}>.`, 'Use Repost Panel in /ticket dashboard.');
  }
  if (!hasCreateTicketButton(panel)) {
    return makeCheck('panel', 'Ticket Panel', 'critical', `Panel message ${panel.id} has no create_ticket button.`, 'Use Repost Panel in /ticket dashboard.');
  }

  return makeCheck('panel', 'Ticket Panel', 'healthy', `<#${channel.id}> • message ${panel.id} is live.`);
}

async function checkStaffRole(guild, config) {
  if (!config.ticketStaffRoleId) {
    return makeCheck('staff_role', 'Ticket Staff Role', 'warning', 'No staff role configured; only Discord admins/managers can manage tickets.', 'Choose a Ticket Staff Role in /ticket dashboard.');
  }

  const role = await fetchRole(guild, config.ticketStaffRoleId);
  if (!role || role.managed || role.id === guild.id) {
    return makeCheck('staff_role', 'Ticket Staff Role', 'critical', 'Configured staff role no longer exists or is invalid.', 'Choose a valid Ticket Staff Role in /ticket dashboard.');
  }

  return makeCheck('staff_role', 'Ticket Staff Role', 'healthy', `<@&${role.id}> is configured.`);
}

async function checkBotPermissions(guild, botMember) {
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
  ];
  const missing = permissionNames(botMember.permissions, required);
  if (missing.length > 0) {
    return makeCheck('bot_permissions', 'Bot Permissions', 'critical', `Missing server permissions: ${missing.join(', ')}.`, `Give Cloudy ${missing.join(', ')} at server/role level.`);
  }
  return makeCheck('bot_permissions', 'Bot Permissions', 'healthy', 'Required server permissions are available.');
}

export async function runTicketHealth(client, guild) {
  await Promise.allSettled([
    guild.channels.fetch(),
    guild.roles.fetch(),
  ]);

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const config = await getGuildConfig(client, guild.id);
  const checks = [];

  checks.push(await checkDatabase(client));

  if (!botMember) {
    checks.push(makeCheck('bot_member', 'Bot Member', 'critical', 'Cloudy could not resolve its server member.', 'Reinvite the bot or check gateway/member access.'));
  } else {
    checks.push(await checkBotPermissions(guild, botMember));
    checks.push(await checkPanel(client, guild, botMember, config));
    checks.push(await checkCategory(guild, botMember, config.ticketCategoryId, 'Open Tickets Category', { required: true }));
    checks.push(await checkCategory(guild, botMember, config.ticketClosedCategoryId, 'Closed Tickets Category'));
    checks.push(await checkStaffRole(guild, config));
    checks.push(await checkTextDestination({
      guild,
      botMember,
      channelId: config.ticketLogsChannelId,
      label: 'Ticket Logs Channel',
      attachments: false,
      required: false,
    }));
    checks.push(await checkTextDestination({
      guild,
      botMember,
      channelId: config.ticketTranscriptChannelId,
      label: 'Transcript Channel',
      attachments: true,
      required: false,
    }));
  }

  const stats = await getGuildTicketStats(guild.id).catch(() => null);
  const critical = checks.filter(check => check.status === 'critical').length;
  const warnings = checks.filter(check => check.status === 'warning').length;
  const overall = critical > 0 ? 'critical' : warnings > 0 ? 'degraded' : 'healthy';

  return {
    overall,
    critical,
    warnings,
    checks,
    stats,
    config,
    gatewayPing: Number.isFinite(client.ws?.ping) ? Math.round(client.ws.ping) : null,
    checkedAt: new Date().toISOString(),
  };
}

export function formatTicketHealthLines(report, { includeFixes = false } = {}) {
  const icons = {
    healthy: '✅',
    warning: '⚠️',
    critical: '❌',
    info: 'ℹ️',
  };

  return report.checks.map(check => {
    const base = `${icons[check.status] || '•'} **${check.label}:** ${check.detail}`;
    if (includeFixes && check.fix) return `${base}\n↳ ${check.fix}`;
    return base;
  });
}
