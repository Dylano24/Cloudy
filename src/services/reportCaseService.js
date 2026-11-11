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
  const guildId = details.guildId || message.guildId || message.guild?.id;
  const number = details.number || await nextReportNumber(client, guildId);
  return save(client, { ...details, guildId, number,
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
  // An older logged report already has a report number. Do not assign it a
  // second, newer number when staff first handle that historical message.
  const originalNumber = Number(report.embeds?.[0]?.title?.match(/\bNew report #(\d+)\b/i)?.[1]
    || fields.find(field => /^Report$/i.test(field.name))?.value?.match(/#(\d+)/)?.[1]);
  return registerReport(client, report, { guildId: guild.id, reporterId, targetId,
    ...(Number.isSafeInteger(originalNumber) && originalNumber > 0 ? { number: originalNumber } : {}),
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

export function reportCaseControls(record, _staff = false, disabled = false, audience = 'target', closed = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_case:close:${record.messageId}:${audience}`)
      .setLabel('Close').setStyle(ButtonStyle.Secondary).setDisabled(disabled || closed),
  )];
}

export async function nextReportNumber(client, guildId) {
  const key = `global:report-counter:${guildId}`;
  if (client.db.isDegraded?.() || client.db.isAvailable?.() === false) throw new Error('The report database is unavailable.');
  const pool = client.db.db?.pool;
  if (pool?.query) {
    const { pgConfig } = await import('../config/database/postgres.js');
    const table = pgConfig.tables.temp_data;
    // Increment atomically from the higher of the old counter or saved report numbers.
    const statement = `WITH previous AS (
      SELECT COALESCE(MAX(CASE
        WHEN value ->> 'number' ~ '^[0-9]+$' THEN (value ->> 'number')::bigint
        ELSE 0 END), 0) AS max_number
      FROM ${table} WHERE key LIKE $2
    )
    INSERT INTO ${table} (key, value, expires_at, created_at)
      SELECT $1, to_jsonb(previous.max_number + 1), NULL, CURRENT_TIMESTAMP FROM previous
    ON CONFLICT (key) DO UPDATE SET value = to_jsonb(GREATEST(
      COALESCE(CASE WHEN ${table}.value::text ~ '^[0-9]+$'
        THEN (${table}.value::text)::bigint END, 0),
      (SELECT max_number FROM previous)
    ) + 1)
    RETURNING value`;
    const result = await pool.query(statement, [key, `global:report:${guildId}:%`]);
    const number = Number(result.rows[0]?.value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('The report counter returned an invalid number.');
    return number;
  }
  return withReportLock(key, async () => {
    let highest = Number(await client.db.get(key)) || 0;
    for (const caseKey of await client.db.list(`global:report:${guildId}:`)) {
      const stored = await client.db.get(caseKey);
      const number = Number(stored?.number);
      if (Number.isSafeInteger(number) && number > highest) highest = number;
    }
    const next = highest + 1;
    if (!Number.isSafeInteger(next) || await client.db.set(key, next) === false) {
      throw new Error('The report counter could not be saved.');
    }
    return next;
  });
}
export { deleteReportCase, scheduleReportCaseExpiry, publishReportOutcome, handleReportCaseControl, restoreReportCaseTimers, validateReportDestinations, REPORT_LOG_CHANNEL_ID } from './reportCaseLifecycleService.js';
