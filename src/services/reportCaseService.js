import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { createEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger, startupLog } from '../utils/logger.js';

export const REPORT_CATEGORY_ID = '1556215327526887555';
export const REPORT_CASE_MS = 24 * 60 * 60_000;
const timers = new Map();
const queues = new Map();
export const reportKey = (guildId, messageId) => `global:report:${guildId}:${messageId}`;

export function withReportLock(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  current.finally(() => { if (queues.get(key) === current) queues.delete(key); }).catch(() => {});
  return current;
}

async function save(client, record) {
  if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) throw new Error('The report could not be saved.');
  return record;
}

export async function registerReport(client, message, details) {
  return save(client, { ...details, guildId: details.guildId || message.guildId || message.guild?.id,
    messageId: message.id, reportChannelId: message.channelId || message.channel?.id, actions: {}, createdAt: Date.now() });
}

export async function loadReport(client, guild, report, targetId) {
  const stored = await client.db.get(reportKey(guild.id, report.id));
  if (stored) {
    if (stored.targetId !== targetId || stored.reportChannelId !== report.channelId) throw new Error('This report does not match the action.');
    return stored;
  }
  // Link older reports from their original evidence, without inventing an ID.
  const fields = report.embeds.flatMap(embed => embed.fields || []);
  const text = report.embeds.map(embed => [embed.description, ...fields.map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('\n');
  const reporterLine = fields.find(f => /reported by/i.test(f.name))?.value || text.match(/reported by[^\n]*$/im)?.[0] || '';
  const reporterId = reporterLine.match(/\d{17,20}/)?.[0];
  if (!reporterId) throw new Error('This older report has no identifiable reporter. Please submit it again.');
  const original = text.match(/https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (original && original[1] !== guild.id) throw new Error('The reported message belongs to another server.');
  return registerReport(client, report, { guildId: guild.id, reporterId, targetId,
    sourceChannelId: original?.[2], sourceMessageId: original?.[3] });
}

export function reportStaffRole(guild, config) {
  return config.ticketStaffRoleId || guild.roles.cache.find(role => role.name.trim().toLowerCase() === 'staff')?.id;
}

export function caseStaffAllowed(guild, member, config) {
  const role = reportStaffRole(guild, config);
  return member?.id === guild.ownerId || Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator))
    || Boolean(role && member?.roles?.cache?.has?.(role));
}

export function reportCaseControls(record, staff = false, disabled = false) {
  const buttons = [new ButtonBuilder().setCustomId(`report_case:read:${record.messageId}`).setLabel('Read').setStyle(ButtonStyle.Secondary).setDisabled(disabled)];
  if (staff) buttons.push(new ButtonBuilder().setCustomId(`report_case:delete:${record.messageId}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setDisabled(disabled));
  return [new ActionRowBuilder().addComponents(buttons)];
}

export async function nextReportNumber(client, guildId) {
  const key = `global:report-counter:${guildId}`;
  if (client.db.isDegraded?.() || client.db.isAvailable?.() === false) throw new Error('The report database is unavailable.');
  const pool = client.db.db?.pool;
  if (pool?.query) {
    const { pgConfig } = await import('../config/database/postgres.js');
    const result = await pool.query(`INSERT INTO ${pgConfig.tables.temp_data} (key, value, expires_at, created_at)
      VALUES ($1, '1'::jsonb, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = to_jsonb(((${pgConfig.tables.temp_data}.value #>> '{}')::bigint) + 1)
      RETURNING value`, [key]);
    return Number(result.rows[0].value);
  }
  return withReportLock(key, async () => {
    const next = (Number(await client.db.get(key)) || 0) + 1;
    if (await client.db.set(key, next) === false) throw new Error('The report counter could not be saved.');
    return next;
  });
}

export async function deleteReportCase(client, guild, record, executor = '24-hour expiry', alreadyLocked = false) {
  const operation = async () => {
    record = await client.db.get(reportKey(record.guildId, record.messageId)) || record;
    if (record.closedAt) return;
    const channel = await guild.channels.fetch(record.caseChannelId).catch(error => { if (error.code === 10003) return null; throw error; });
    if (channel) await channel.delete(`Report ${record.number}: ${executor}`);
    await save(client, { ...record, closedAt: Date.now() });
    clearTimeout(timers.get(reportKey(record.guildId, record.messageId)));
    timers.delete(reportKey(record.guildId, record.messageId));
    const staffChannel = await guild.channels.fetch(record.reportChannelId).catch(() => null);
    for (const id of record.staffMessageIds || []) {
      const message = await staffChannel?.messages.fetch(id).catch(() => null);
      if (message?.author?.id === client.user.id) await message.edit({ components: reportCaseControls(record, true, true) }).catch(() => {});
    }
  };
  return alreadyLocked ? operation() : withReportLock(reportKey(record.guildId, record.messageId), operation);
}

export function scheduleReportCaseExpiry(client, guild, record, retryMs) {
  if (!record.caseChannelId || record.closedAt) return;
  const key = reportKey(record.guildId, record.messageId);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    void deleteReportCase(client, guild, record).catch(error => {
      logger.warn(`Report case expiry failed: ${error.message}`);
      scheduleReportCaseExpiry(client, guild, record, 60_000);
    });
  }, retryMs ?? Math.max(0, record.expiresAt - Date.now()));
  timer.unref?.(); timers.set(key, timer);
}

export async function publishReportOutcome(client, guild, report, record, action, actorId, reason) {
  const config = await getGuildConfig(client, guild.id);
  const staffId = reportStaffRole(guild, config);
  const sourceChannel = report.channel || await guild.channels.fetch(record.reportChannelId);
  if (sourceChannel.permissionsFor?.(guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) throw new Error('Staff report controls require a private reports channel.');
  let channel = record.caseChannelId ? await guild.channels.fetch(record.caseChannelId) : null;
  if (record.closedAt) throw new Error('This report case has expired or was deleted.');
  if (!channel) {
    const category = await guild.channels.fetch(REPORT_CATEGORY_ID);
    if (category?.type !== ChannelType.GuildCategory) throw new Error('The Reports category is unavailable.');
    const number = await nextReportNumber(client, guild.id);
    const overwrites = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...[...new Set([record.reporterId, guild.ownerId, client.user.id])].map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ...(staffId ? [{ id: staffId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : [])];
    channel = await guild.channels.create({ name: `report-${number}`, type: ChannelType.GuildText, parent: category.id,
      permissionOverwrites: overwrites, reason: `Report ${record.messageId}` });
    record = { ...record, number, caseChannelId: channel.id, expiresAt: Date.now() + REPORT_CASE_MS };
    try { await save(client, record); } catch (error) { await channel.delete('Report case could not be saved').catch(() => {}); throw error; }
    scheduleReportCaseExpiry(client, guild, record);
  }
  const actionText = { delete: 'The reported message has been deleted.', timeout: 'The reported member has been timed out.', ban: 'The reported member has been banned.' }[action];
  const data = { title: 'Report action log', description: `${actionText}\n\n**Case:** report-${record.number}\n**Handled by:** <@${actorId}>${reason ? `\n**Reason:** ${reason}` : ''}\n**Case channel:** <#${channel.id}>`,
    color: 'success', fields: [{ name: 'Time remaining', value: `<t:${Math.floor(record.expiresAt / 1000)}:R>\nThis case is automatically deleted after 24 hours.` }] };
  const tags = `<@${record.reporterId}> ${staffId ? `<@&${staffId}>` : `<@${guild.ownerId}>`}`;
  const allowedMentions = { parse: [], users: [record.reporterId, guild.ownerId], roles: staffId ? [staffId] : [] };
  const staffMessage = await sourceChannel.send({ content: tags, embeds: [createEmbed(data)], components: reportCaseControls(record, true), allowedMentions });
  await channel.send({ content: tags, embeds: [createEmbed(data)], allowedMentions });
  const memberMessage = await channel.send({ content: `<@${record.reporterId}>`, embeds: [createEmbed({ ...data, title: 'Report case notification' })],
    components: reportCaseControls(record), allowedMentions: { parse: [], users: [record.reporterId] } });
  return save(client, { ...record, staffMessageIds: [...(record.staffMessageIds || []), staffMessage.id], memberMessageIds: [...(record.memberMessageIds || []), memberMessage.id] });
}

export async function handleReportCaseControl(interaction, client, [action, messageId]) {
  if (!interaction.inGuild() || !['read', 'delete'].includes(action)) return;
  await interaction.deferReply({ flags: 64 });
  try {
    const key = reportKey(interaction.guildId, messageId);
    await withReportLock(key, async () => {
      const record = await client.db.get(key);
      if (!record || record.closedAt || interaction.message.author?.id !== client.user.id) throw new Error('This report case is no longer available.');
      const config = await getGuildConfig(client, interaction.guildId);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const staff = caseStaffAllowed(interaction.guild, member, config);
      const staffMessage = record.staffMessageIds?.includes(interaction.message.id) && interaction.channelId === record.reportChannelId;
      const memberMessage = record.memberMessageIds?.includes(interaction.message.id) && interaction.channelId === record.caseChannelId;
      if ((!staffMessage && !memberMessage) || (staffMessage && !staff)) throw new Error('You cannot use these report controls.');
      if (action === 'delete') {
        if (!staff || !staffMessage) throw new Error('Only the staff team can delete report cases.');
        await deleteReportCase(client, interaction.guild, record, interaction.user.id, true);
      } else {
        if (!staffMessage && interaction.user.id !== record.reporterId) throw new Error('Only the reporting member can acknowledge this message.');
        const readBy = { ...(record.readBy || {}) };
        if (!readBy[interaction.user.id]?.notified) {
          readBy[interaction.user.id] = { at: Date.now(), notified: false };
          await save(client, { ...record, readBy });
          const channel = await interaction.guild.channels.fetch(record.reportChannelId);
          const role = reportStaffRole(interaction.guild, config);
          await channel.send({ content: role ? `<@&${role}>` : `<@${interaction.guild.ownerId}>`,
            embeds: [createEmbed({ title: 'Report read log', description: `<@${interaction.user.id}> has read the notification for report-${record.number}.`, color: 'success' })],
            allowedMentions: { parse: [], roles: role ? [role] : [], users: role ? [] : [interaction.guild.ownerId] } });
          readBy[interaction.user.id].notified = true;
          await save(client, { ...record, readBy });
        }
      }
    });
    await interaction.deleteReply().catch(() => {});
  } catch (error) { await InteractionHelper.safeEditReply(interaction, { content: `Error: ${error.message}` }); }
}

export async function restoreReportCaseTimers(client) {
  let restored = 0;
  for (const key of await client.db.list('global:report:')) {
    const record = await client.db.get(key);
    const guild = record && client.guilds.cache.get(record.guildId);
    if (guild && record.caseChannelId && !record.closedAt) { scheduleReportCaseExpiry(client, guild, record); restored++; }
  }
  startupLog(`Report case expiry restored: ${restored} active case(s).`);
}
