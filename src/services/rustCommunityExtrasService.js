import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from './gameFeedService.js';
import { logger } from '../utils/logger.js';
import { isCloudyStaffMember } from './cloudyStaffAccess.js';

const CONFIG_PREFIX = 'rust-community-extras:';
const MAX_SERVERS = 10;
const SELECT_PREFIX = 'rustcommunity:role:';
const PRIVILEGED = [
  PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
];
const cached = new Map();
const pendingSelection = new Set();
const recentHoneypotEvents = new Map();

function key(guildId) {
  return CONFIG_PREFIX + guildId;
}

function cleanConfig(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    servers: Array.isArray(item.servers) ? item.servers.slice(0, MAX_SERVERS)
      .filter(s => s && /^\d{17,20}$/.test(String(s.roleId)) && typeof s.name === 'string') : [],
    panel: item.panel && typeof item.panel === 'object' ? item.panel : null,
    honeypot: item.honeypot && typeof item.honeypot === 'object' ? item.honeypot : null,
  };
}

export async function loadRustCommunityConfig(client, guildId) {
  const entry = cached.get(guildId);
  if (entry && entry.until > Date.now()) return entry.value;
  const value = cleanConfig(await client.db.get(key(guildId)));
  cached.set(guildId, { value, until: Date.now() + 30_000 });
  return value;
}

export async function saveRustCommunityConfig(client, guildId, value) {
  const normalized = cleanConfig(value);
  const stored = await client.db.set(key(guildId), normalized);
  if (stored === false) throw new Error('Could not save the Rust community settings.');
  cached.set(guildId, { value: normalized, until: Date.now() + 30_000 });
  return normalized;
}

export function resetRustCommunityCache() {
  cached.clear();
  recentHoneypotEvents.clear();
  pendingSelection.clear();
}

export function roleCanBeSelected(role, botMember) {
  if (!role || role.id === role.guild?.id || role.managed) return false;
  if (role.permissions?.any?.(PRIVILEGED)) return false;
  const highest = botMember?.roles?.highest?.position;
  if (typeof highest === 'number' && role.position >= highest) return false;
  if (role.editable === false) return false;
  return true;
}

function embed(title, description, color = 0xFFFFFF) {
  return {
    title, description, color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
}

export function buildServerSelector(config, guild) {
  const servers = config.servers.filter(s => guild.roles.cache.has(s.roleId));
  const description = servers.length
    ? 'Choose a Rust server to add or remove its role.'
    : 'No Rust servers configured.';
  const components = [];
  for (let i = 0; i < servers.length; i += 5) {
    const buttons = servers.slice(i, i + 5).map(server => new ButtonBuilder()
      .setCustomId(SELECT_PREFIX + server.roleId)
      .setLabel(server.name.slice(0, 80))
      .setStyle(ButtonStyle.Secondary));
    components.push(new ActionRowBuilder().addComponents(buttons));
  }
  return { embeds: [embed('Rust server selector', description)], components, allowedMentions: { parse: [] } };
}

export async function addRustServer(client, guild, role, name) {
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!roleCanBeSelected(role, botMember)) throw new Error('Choose an editable role without staff permissions.');
  const cleanName = String(name || role.name).trim();
  if (!cleanName || cleanName.length > 80) throw new Error('Enter a server name (1–80 characters).');
  const config = await loadRustCommunityConfig(client, guild.id);
  const current = config.servers.filter(s => s.roleId !== role.id);
  if (current.length >= MAX_SERVERS) throw new Error('You can configure up to 10 servers.');
  current.push({ roleId: role.id, name: cleanName });
  return saveRustCommunityConfig(client, guild.id, { ...config, servers: current });
}

export async function removeRustServer(client, guildId, roleId) {
  const config = await loadRustCommunityConfig(client, guildId);
  return saveRustCommunityConfig(client, guildId, {
    ...config, servers: config.servers.filter(s => s.roleId !== roleId),
  });
}

export async function publishRustSelector(client, guild, channel) {
  const config = await loadRustCommunityConfig(client, guild.id);
  if (!config.servers.length) throw new Error('Add a Rust server first.');
  const panel = buildServerSelector(config, guild);
  if (config.panel?.channelId === channel.id && config.panel?.messageId) {
    const existing = await channel.messages.fetch(config.panel.messageId).catch(() => null);
    if (existing) {
      await existing.edit(panel);
      return existing;
    }
  }
  const posted = await channel.send(panel);
  // An old panel cannot grant roles after the new one has been stored.
  await saveRustCommunityConfig(client, guild.id, {
    ...config, panel: { channelId: channel.id, messageId: posted.id },
  });
  if (config.panel && (config.panel.channelId !== channel.id || config.panel.messageId !== posted.id)) {
    const oldChannel = await guild.channels.fetch(config.panel.channelId).catch(() => null);
    const old = await oldChannel?.messages?.fetch(config.panel.messageId).catch(() => null);
    await old?.edit({ components: [] }).catch(() => {});
  }
  return posted;
}

export async function handleRustSelectorButton(interaction) {
  if (!interaction.isButton?.() || !interaction.customId?.startsWith(SELECT_PREFIX)) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const roleId = interaction.customId.slice(SELECT_PREFIX.length);
  const config = await loadRustCommunityConfig(interaction.client, interaction.guildId);
  const allowed = config.servers.some(s => s.roleId === roleId)
    && config.panel?.channelId === interaction.channelId
    && config.panel?.messageId === interaction.message?.id;
  if (!allowed) {
    await interaction.editReply({ embeds: [embed('Unavailable', 'This server selector is no longer active.', 0x7A1712)] });
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const role = await interaction.guild.roles.fetch(roleId);
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  if (!roleCanBeSelected(role, botMember)) {
    await interaction.editReply({ embeds: [embed('Unavailable', 'This server role cannot be assigned.', 0x7A1712)] });
    return true;
  }
  const lockKey = interaction.guildId + ':' + member.id;
  if (pendingSelection.has(lockKey)) {
    await interaction.editReply({ embeds: [embed('Please try again', 'Your previous selection is still being saved.')] });
    return true;
  }
  pendingSelection.add(lockKey);
  try {
    const selected = member.roles.cache.has(roleId);
    if (selected) await member.roles.remove(roleId, 'Rust server role removed by member');
    else await member.roles.add(roleId, 'Rust server role selected by member');
    await interaction.editReply({
      embeds: [embed(selected ? 'Server removed' : 'Server selected',
        selected ? 'Your server role was removed.' : 'Your server role was added.', selected ? 0xFFFFFF : 0x00C49D)],
      allowedMentions: { parse: [] },
    });
  } finally {
    pendingSelection.delete(lockKey);
  }
  return true;
}

export async function setRustHoneypot(client, guildId, channelId, logChannelId, mode = 'monitor') {
  if (!['monitor', 'kick'].includes(mode)) throw new Error('Invalid honeypot mode.');
  if (channelId === logChannelId) throw new Error('Use a separate channel for logs.');
  const config = await loadRustCommunityConfig(client, guildId);
  return saveRustCommunityConfig(client, guildId, {
    ...config, honeypot: { channelId, logChannelId, mode },
  });
}

export async function disableRustHoneypot(client, guildId) {
  const config = await loadRustCommunityConfig(client, guildId);
  return saveRustCommunityConfig(client, guildId, { ...config, honeypot: null });
}

export async function handleRustHoneypotMessage(message) {
  if (!message?.guild || !message.author || message.author.id === message.client.user?.id || message.webhookId) return false;
  const config = await loadRustCommunityConfig(message.client, message.guild.id);
  const honeypot = config.honeypot;
  if (!honeypot || honeypot.channelId !== message.channelId) return false;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || isCloudyStaffMember(member, {}, message.guild)
    || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return false;
  const activityKey = message.guild.id + ':' + message.author.id;
  const recent = recentHoneypotEvents.get(activityKey) || 0;
  if (recent > Date.now() - 15_000) return true;
  recentHoneypotEvents.set(activityKey, Date.now());
  // Do not delete messages or punish anyone unless kick mode was explicitly enabled.
  let outcome = 'Detected';
  if (honeypot.mode === 'kick') {
    if (member.kickable) {
      try {
        await member.kick('Posted in the configured honeypot channel');
        outcome = 'Kicked';
      } catch (error) {
        logger.warn('[RUST_COMMUNITY] Honeypot kick failed:', error);
        outcome = 'Kick failed';
      }
    } else {
      outcome = 'Cannot kick';
    }
  }
  const log = await message.guild.channels.fetch(honeypot.logChannelId).catch(() => null);
  if (log?.type === ChannelType.GuildText && log.permissionsFor(message.client.user)?.has(PermissionFlagsBits.SendMessages)) {
    await log.send({
      embeds: [embed('Honeypot alert',
        '**Member:** <@' + member.id + '>\n**Channel:** <#' + message.channelId + '>\n**Action:** ' + outcome,
        outcome === 'Kicked' ? 0x7A1712 : 0xFFFFFF)],
      allowedMentions: { parse: [] },
    }).catch(error => logger.warn('[RUST_COMMUNITY] Honeypot log failed:', error));
  }
  if (recentHoneypotEvents.size > 5000) recentHoneypotEvents.clear();
  return true;
}

export function statusRustCommunityEmbed(config, guild) {
  return embed('Rust community',
    '**Server roles:** ' + config.servers.length + '/' + MAX_SERVERS
    + '\n**Server selector:** ' + (config.panel ? '<#' + config.panel.channelId + '>' : 'Not posted')
    + '\n**Honeypot:** ' + (config.honeypot ? config.honeypot.mode : 'Off')
    + '\n**Forums:** ' + ['looking-for-group', 'suggestions']
      .map(name => guild.channels.cache.some(channel => channel.name === name && channel.type === ChannelType.GuildForum)
        ? name + ' ready' : name + ' not set').join(', '));
}

export async function ensureRustCommunityForums(guild) {
  const names = [
    { name: 'looking-for-group', topic: 'Find Rust teammates and groups.', tags: [] },
    { name: 'suggestions', topic: 'Ideas for the Rust and Discord servers.',
      tags: [{ name: 'Rust server' }, { name: 'Discord server' }] },
  ];
  const results = [];
  for (const item of names) {
    const existing = guild.channels.cache.find(channel => channel.name === item.name);
    if (existing) {
      results.push({ name: item.name, created: false, supported: existing.type === ChannelType.GuildForum });
      continue;
    }
    const created = await guild.channels.create({
      name: item.name, type: ChannelType.GuildForum, topic: item.topic, availableTags: item.tags,
      reason: 'Cloudy Rust community forum setup',
    });
    results.push({ name: created.name, created: true, supported: true });
  }
  return results;
}
