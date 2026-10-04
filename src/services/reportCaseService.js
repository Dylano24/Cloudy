import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';

export const REPORT_CATEGORY_ID = '1556215327526887555';
export const REPORT_CASE_MS = 24 * 60 * 60_000;
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
  return member?.id === guild.ownerId || hasCloudyOwnerMember(member) || Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator))
    || Boolean(role && member?.roles?.cache?.has?.(role));
}

export function reportCaseControls(record, staff = false, disabled = false, audience = 'target', closed = false) {
  const buttons = [new ButtonBuilder().setCustomId(`report_case:close:${record.messageId}:${audience}`).setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(disabled || closed)];
  if (staff) buttons.push(new ButtonBuilder().setCustomId(`report_case:delete:${record.messageId}:${audience}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setDisabled(disabled));
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

export { deleteReportCase, scheduleReportCaseExpiry, publishReportOutcome, handleReportCaseControl, restoreReportCaseTimers, validateReportDestinations, updateReportCountdowns, REPORT_LOG_CHANNEL_ID, REPORT_COUNTDOWN_REFRESH_MS } from './reportCaseLifecycleService.js';
