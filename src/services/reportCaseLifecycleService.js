// CLOUDY_INTERACTION_LATENCY_V1
import { EmbedBuilder, escapeMarkdown, ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { formatDuration } from '../utils/embeds.js';
import { truncateMessageLogText } from '../utils/logging/preserveMessageText.js';
import { REPORT_MODERATION_FOOTER } from '../utils/reportCasePrivacy.js';
import { feedEmoji } from './feedEmojiService.js';
import { reportAttachmentLines } from './reportAttachmentService.js';
import { getGuildConfig } from './config/guildConfig.js';
import { buildStandardLogEmbed } from '../utils/logging/logEmbeds.js';
import { CLOUDY_STANDARD_FOOTER, withReportCaseNoticeNumber, withReportStaffLogBranding } from '../utils/cloudyFooter.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../utils/embedColorPolicy.js';
import { TICKET_EVENT_STYLES } from '../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger, startupLog } from '../utils/logger.js';
import { reportKey, withReportLock, reportStaffRole, caseStaffAllowed, nextReportNumber, reportCaseControls, REPORT_CATEGORY_ID, REPORT_CASE_MS } from './reportCaseService.js';

export const REPORT_LOG_CHANNEL_ID = '1556344268099166319';
const expiryTimers = new Map();
const audiences = ['reporter', 'target'];
const reportDeletePresentationJobs = new Map();

function caseEmbed(data) {
  const embed = buildStandardLogEmbed({ ...data, color: null, footer: data.footer || { text: CLOUDY_STANDARD_FOOTER }, thumbnail: data.thumbnail === undefined ? CLOUDY_LOGO_URL : data.thumbnail });
  if (data.footer) embed.data.footer = data.footer;
  setPreservedEmbedColor(embed, data.color ?? 0xFFFFFF);
  return embed;
}

async function save(client, record) {
  if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) throw new Error('The report could not be saved.');
  return record;
}

// Persist one presentation field against the latest case. Long Discord REST
// calls must never hold the report lock or overwrite another case update.
async function saveCasePresentationField(client, key, audience, field, value) {
  return withReportLock(key, async () => {
    const latest = await client.db.get(key);
    if (!latest?.cases?.[audience]) return latest;
    // A deleted channel still needs its essential close/delete log IDs. Never
    // restore a private notification after deletion.
    if (latest.cases[audience].deletedAt && !field.endsWith('LogId') && !['logTitlesUpgraded', 'reportLogPresentationV3', 'reportLogPresentationV4'].includes(field)) return latest;
    latest.cases[audience][field] = value;
    return save(client, latest);
  });
}

async function fetchChannel(guild, id) {
  if (!id) return null;
  // A channel of another server (discord.js: GuildChannelUnowned) is unavailable here, like a deleted one.
  return guild.channels.fetch(id).catch(error => { if (error.code === 10003 || error.code === 'GuildChannelUnowned') return null; throw error; });
}

async function fetchMessage(channel, id) {
  if (!channel || !id) return null;
  return channel.messages.fetch(id).catch(error => { if (error.code === 10008) return null; throw error; });
}

export async function validateReportDestinations(guild) {
  const [category, logs] = await Promise.all([
    fetchChannel(guild, REPORT_CATEGORY_ID),
    fetchChannel(guild, REPORT_LOG_CHANNEL_ID),
  ]);
  if (category?.type !== ChannelType.GuildCategory) throw new Error('The Reports category is unavailable.');
  if (!logs?.send || logs.permissionsFor?.(guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) {
    throw new Error('The private report-logs channel is unavailable.');
  }
  return { category, logs };
}

function participantId(record, audience) { return audience === 'reporter' ? record.reporterId : record.targetId; }

async function showReportPermissionDenied(interaction, description, respondPrivately, scheduleDeletion) {
  const embed = caseEmbed({
    title: 'Permission denied',
    description,
    color: CLOUDY_RED_COLOR,
  });
  const message = await respondPrivately({
    content: null,
    embeds: [embed],
    components: [],
    allowedMentions: { parse: [] },
  });
  scheduleDeletion(message);
}

function caseOverwrites(guild, client, config, participant) {
  const staffId = reportStaffRole(guild, config);
  const memberIds = [...new Set([participant, guild.ownerId, client.user.id].filter(Boolean))];
  const roleIds = [...new Set([staffId, ...[...guild.roles.cache.values()].filter(role => String(role.name || '').trim().toLowerCase() === 'owner').map(role => role.id)].filter(Boolean))];
  const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [{ id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...memberIds.map(id => ({ id, type: OverwriteType.Member, allow })), ...roleIds.map(id => ({ id, type: OverwriteType.Role, allow }))];
}

function syncAliases(record) {
  record.caseChannelId = record.cases.target?.channelId;
  record.reporterCaseChannelId = record.cases.reporter?.channelId;
  record.memberMessageIds = record.cases.target?.messageId ? [record.cases.target.messageId] : [];
  return record;
}

async function ensurePrivateCases(client, guild, report, record, config, activeAudiences = audiences) {
  const { category } = await validateReportDestinations(guild);
  if (!record.number) record.number = await nextReportNumber(client, guild.id);
  if (!record.expiresAt) record.expiresAt = Date.now() + REPORT_CASE_MS;
  if (!record.cases) {
    record.cases = {};
    if (record.caseChannelId) record.cases.target = { channelId: record.caseChannelId, messageId: record.memberMessageIds?.at(-1) };
  }
  if (!activeAudiences.includes('target') && record.cases.target) {
    const staleTarget = record.cases.target;
    const staleChannel = await fetchChannel(guild, staleTarget.channelId);
    if (staleChannel) await staleChannel.delete(`Report ${record.messageId}: target case not required after ban`);
    delete record.cases.target;
    await save(client, syncAliases(record));
  }
  // Persist each channel before creating the next one so notification retries
  // resume the same pair rather than creating duplicate case channels.
  for (const audience of activeAudiences) {
    let entry = record.cases[audience];
    if (entry?.deletedAt) continue;
    let channel = await fetchChannel(guild, entry?.channelId);
    if (entry?.channelId && !channel) throw new Error('This report case channel was deleted. Staff must delete its remaining case record.');
    const overwrites = caseOverwrites(guild, client, config, participantId(record, audience));
    if (!channel) {
      const first = audience === 'target' ? await fetchChannel(guild, record.cases.reporter.channelId) : null;
      channel = await guild.channels.create({ name: `report-${record.number}`, type: ChannelType.GuildText, parent: category.id,
        permissionOverwrites: overwrites, ...(Number.isFinite(first?.rawPosition) ? { position: first.rawPosition + 1 } : {}), reason: `Report ${record.messageId}: ${audience}` });
      entry = { channelId: channel.id };
      record.cases[audience] = entry;
      try { await save(client, syncAliases(record)); }
      catch (error) { await channel.delete('Report case could not be saved').catch(() => {}); throw error; }
      scheduleReportCaseExpiry(client, guild, record);
    } else if (!entry.privateLayout) {
      // Upgrade an old shared case in place without retaining the reporter's access.
      await channel.permissionOverwrites.set(overwrites);
    }
    if (!entry.privateLayout) {
      entry.privateLayout = true;
      await save(client, record);
    }
  }
  const first = await fetchChannel(guild, record.cases.reporter?.channelId);
  const second = await fetchChannel(guild, record.cases.target?.channelId);
  if (first && second && !record.pairPositioned) {
    if (Number.isFinite(first.rawPosition) && guild.channels.setPositions) {
      await guild.channels.setPositions([{ channel: first.id, position: first.rawPosition }, { channel: second.id, position: first.rawPosition + 1 }]);
    }
    record.pairPositioned = true;
    await save(client, record);
  }
  // Only remove the old extra action log, never the original New report embed.
  const source = report.channel || await fetchChannel(guild, record.reportChannelId);
  for (const id of record.staffMessageIds || []) {
    if (id === record.messageId) continue;
    const message = await fetchMessage(source, id);
    if (message?.author?.id === client.user.id) await message.delete();
  }
  record.staffMessageIds = [];
  return save(client, syncAliases(record));
}

const REPORT_LOG_TITLES = {
  reporter: { created: 'Report update', close: 'Report update closed', delete: 'Report update deleted' },
  target: { created: 'Moderation update', close: 'Moderation update closed', delete: 'Report moderation deleted' },
};

// The moment the event happened, as Discord's own date and time (shown in each
// viewer's time zone): the last section of every report staff log.
function logEventTime(entry, event) {
  const at = event === 'close' ? entry?.closedAt : event === 'delete' ? entry?.deletedAt : entry?.createdLogAt;
  return Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now();
}

function logEmbed(record, audience, event, actorId) {
  const title = REPORT_LOG_TITLES[audience][event === 'close' ? 'close' : event === 'delete' ? 'delete' : 'created'];
  const fields = [{ name: 'Report', value: `#${record.number}`, inline: true },
    { name: 'Member', value: `<@${participantId(record, audience)}>`, inline: true },
    { name: event === 'close' ? 'Closed by' : event === 'delete' ? 'Reason' : 'Handled by', value: event === 'delete' ? 'Automatic · 24-hour expiry' : actorId === 'Unknown' ? 'Unknown' : `<@${actorId}>`, inline: true },
    { name: 'Audience', value: audience === 'reporter' ? 'Reporter' : 'Reported member', inline: true },
    { name: 'Date', value: `<t:${Math.floor(logEventTime(record.cases?.[audience], event) / 1000)}:F>`, inline: false }];
  const embed = caseEmbed({ title, fields, footer: { text: CLOUDY_STANDARD_FOOTER } });
  embed.setThumbnail(CLOUDY_LOGO_URL);
  embed.data.footer = { text: CLOUDY_STANDARD_FOOTER };
  if (event === 'close' || event === 'delete') setPreservedEmbedColor(embed, TICKET_EVENT_STYLES[event].color);
  return embed;
}

async function publishStaffLog(client, guild, record, audience, event, actorId, persistField = false) {
  const logs = await fetchChannel(guild, REPORT_LOG_CHANNEL_ID);
  if (!logs?.send) throw new Error('The report-logs channel is unavailable.');
  const entry = record.cases[audience];
  if (event === 'created' && !entry.createdLogAt) entry.createdLogAt = Date.now();
  // A deletion title is reserved exclusively for unattended 24-hour expiry.
  // Manual Close/Delete actions are logged as closed, never as deleted.
  if (event === 'delete' && entry.deletedBy !== '24-hour expiry') {
    throw new Error('Report deleted logs are reserved for 24-hour automatic expiry.');
  }
  const key = event === 'close' ? 'closeLogId' : event === 'delete' ? 'deleteLogId' : 'createdLogId';
  const existing = await fetchMessage(logs, entry[key]);
  const payload = { content: null,
    embeds: [logEmbed(record, audience, event, actorId)],
    components: [],
    allowedMentions: { parse: [] } };
  const message = await withReportStaffLogBranding(() =>
    existing?.author?.id === client.user.id ? existing.edit(payload) : logs.send(payload));
  entry[key] = message.id;
  if (persistField) {
    return saveCasePresentationField(client, reportKey(record.guildId, record.messageId), audience, key, message.id);
  }
  await save(client, record);
  return record;
}

// Upgrade existing bot-owned report logs in place, once per case/audience.
// Do not duplicate messages, alter report metadata, or touch other log systems.
// Reconcile both previously migrated and old report-logs by their persisted
// Discord message IDs. Earlier migrations skipped messages whose footer and
// Report # field disagreed, leaving obsolete R-numbers visible in staff logs.
async function upgradeExistingReportLogPresentation(client, guild, record, audience) {
  const entry = record.cases?.[audience];
  if (!entry || entry.reportLogPresentationV4) return;
  const logs = await fetchChannel(guild, REPORT_LOG_CHANNEL_ID);
  if (!logs?.messages?.fetch) return;

  for (const [idField, event] of [
    ['createdLogId', 'created'],
    ['closeLogId', 'close'],
    ['deleteLogId', 'delete'],
  ]) {
    if (!entry[idField]) continue;
    // An event logged as "deleted" can only be produced by 24-hour expiry.
    if (event === 'delete' && entry.deletedBy !== '24-hour expiry') continue;
    const message = await fetchMessage(logs, entry[idField]);
    if (!message || message.author?.id !== client.user.id) continue;
    const current = message.embeds?.[0];
    const original = current?.toJSON?.() || current;
    if (!original?.fields?.some(field => field.name === 'Report' && /^#\d+$/.test(field.value || ''))) continue;
    const currentAudience = original.fields.find(field => field.name === 'Audience')?.value;
    const expectedAudience = audience === 'reporter' ? 'Reporter' : 'Reported member';
    if (currentAudience && currentAudience !== expectedAudience) continue;
    const desiredTitle = REPORT_LOG_TITLES[audience][event];
    const desiredColor = event === 'delete' ? TICKET_EVENT_STYLES.delete.color
      : event === 'close' ? TICKET_EVENT_STYLES.close.color : 0xFFFFFF;
    const requiresEdit = original.title !== desiredTitle
      || original.footer?.text !== CLOUDY_STANDARD_FOOTER
      || original.color !== desiredColor
      || original.thumbnail?.url !== CLOUDY_LOGO_URL;
    if (!requiresEdit) continue;
    const updated = EmbedBuilder.from(current).setTitle(desiredTitle);
    updated.data.footer = { text: CLOUDY_STANDARD_FOOTER };
    delete updated.data.timestamp;
    updated.setThumbnail(CLOUDY_LOGO_URL);
    setPreservedEmbedColor(updated, desiredColor);
    await withReportStaffLogBranding(() => message.edit({ embeds: [updated], components: [] }));
  }
  await saveCasePresentationField(client, reportKey(record.guildId, record.messageId), audience, 'reportLogPresentationV4', true);
}
async function refreshLogControls(client, guild, record, audience) {
  const logs = await fetchChannel(guild, REPORT_LOG_CHANNEL_ID);
  const entry = record.cases[audience];

  const created = await fetchMessage(logs, entry.createdLogId);
  if (created?.author?.id === client.user.id) {
    await created.edit({ content: null, components: [], allowedMentions: { parse: [] } });
  }

  const closed = await fetchMessage(logs, entry.closeLogId);
  if (closed?.author?.id === client.user.id) {
    await withReportStaffLogBranding(() => closed.edit({
      content: null,
      embeds: [logEmbed(record, audience, 'close', entry.closedBy || 'Unknown')],
      components: [],
      allowedMentions: { parse: [] },
    }));
  }

  const deleted = await fetchMessage(logs, entry.deleteLogId);
  if (deleted?.author?.id === client.user.id) {
    await deleted.edit({
      content: null,
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

function reportedMessageText(record, report) {
  if (typeof record.reportedMessageText === 'string') return record.reportedMessageText;
  const fields = (report.embeds || []).flatMap(embed => embed.fields || []);
  const direct = fields.find(field => /^reported message$/i.test(field.name))?.value;
  if (direct) return direct;
  const evidence = fields.find(field => /^evidence$/i.test(field.name))?.value;
  return evidence?.match(/(?:^|\n)(?:\*\*Content\*\*\n|Content: *)([\s\S]*?)(?=\n(?:\*\*Channel\*\*|Channel:)|$)/i)?.[1] || '';
}

function reportFooterText(record, channelName) {
  // A case's channel may have been renamed since its number was stored.
  // Match the visible channel number without changing the report's database identity.
  const channelNumber = /^report-([1-9]\d*)$/i.exec(String(channelName || ''))?.[1];
  return `${REPORT_MODERATION_FOOTER} • R${channelNumber || record.number}`;
}

// Discord's embed fields have fixed spacing that does not match the title-to-description
// spacing. Render these two private notifications as one Markdown description instead:
// every section then gets the same single paragraph break across mobile and desktop.
function reportSectionText(value) {
  return String(value || '').replace(/^\u200b\n+/, '').replace(/(?:\n\u200b|\n)+$/, '');
}

// Less space than an empty line: an empty line in Discord's small text, the same small
// gap as in the Server wiped post (`SMALL_GAP` in gameFeedService.js).
export const REPORT_SMALL_GAP = '-# \u200b';

// The owner's spacing for every report message people see (not the staff logs): the
// sections of a notice sit right under each other, and wherever a gap is wanted it is a
// SMALL gap (an empty line in small text), never a full empty line. Runs on new notices
// and fixes active ones at startup, once.
function compactHighlightedReportGaps(description) {
  return String(description || '')
    .replace(/(\*\*Reported member\*\*\n[\s\S]*?)\n\n(?=\*\*Reported message\*\*\n)/, '$1\n')
    .replace(/(\*\*Reported message\*\*\n[\s\S]*?)\n\n(?=\*\*Review outcome\*\*\n)/, '$1\n')
    // Only moderation notices contain these three adjoining sections.
    .replace(/(\*\*Review outcome\*\*\n[\s\S]*?)\n\n(?=\*\*Moderation action\*\*\n)/, '$1\n')
    .replace(/(\*\*Moderation action\*\*\n[\s\S]*?)\n\n(?=\*\*Reason\*\*\n)/, '$1\n')
    // Moderation update: a small gap between the reason and Auto-close (was a full empty line).
    .replace(/(\*\*Reason\*\*\n[\s\S]*?)\n+(?:-# \u200b\n+)?(?=\*\*Auto-close\*\*\n)/, `$1\n${REPORT_SMALL_GAP}\n`)
    // Moderation update: a small gap under its opening sentence, and between "...at this
    // time." (no action taken) and Auto-close.
    .replace(/(and has been reviewed\.)\n+(?:-# \u200b\n+)?(?=\*\*Reported message\*\*\n)/, `$1\n${REPORT_SMALL_GAP}\n`)
    .replace(/(at this time\.)\n+(?:-# \u200b\n+)?(?=\*\*Auto-close\*\*\n)/, `$1\n${REPORT_SMALL_GAP}\n`)
    // Reporter notice (owner's choice, highlighted: "less space", not none): a small-text
    // empty line between the outcome text and the thanks, and between the thanks and
    // Auto-close, also on existing notices (a full empty line or none is replaced).
    .replace(/(server rules\.|deemed necessary\.)\n+(?:-# \u200b\n+)?(?=Thank you for bringing this)/, `$1\n${REPORT_SMALL_GAP}\n`)
    .replace(/(fair and safe\.)\n+(?:-# \u200b\n+)?(?=\*\*Auto-close\*\*\n)/, `$1\n${REPORT_SMALL_GAP}\n`)
    // And (owner's choice, highlighted later): between "Reviewed" and its sentence, between
    // that sentence and Reported member, and between the outcome and its explanation.
    .replace(/(Reviewed)\n+(?:-# \u200b\n+)?(?=Your report has been reviewed)/, `$1\n${REPORT_SMALL_GAP}\n`)
    .replace(/(by our moderation team\.)\n+(?:-# \u200b\n+)?(?=\*\*Reported member\*\*\n)/, `$1\n${REPORT_SMALL_GAP}\n`)
    .replace(/(Action taken|No action taken)\n+(?:-# \u200b\n+)?(?=Appropriate action has been taken|No further action was deemed necessary|After reviewing the report)/, `$1\n${REPORT_SMALL_GAP}\n`);
}

function reportNoticeDescription(intro, fields) {
  const normalizedIntro = reportSectionText(intro).replace(/Reviewed\n(?=Your report has)/, 'Reviewed\n\n');
  return compactHighlightedReportGaps([normalizedIntro, ...fields.map(({ name, value }) =>
    `**${name}**\n${reportSectionText(value)}`)].join('\n\n'));
}

function spacedReportOutcome(value) {
  return String(value || '')
    .replace(/(Action taken|No action taken)\n(?=[^\n])/, '$1\n\n');
}

// Update only active private notices in place on startup (including mismatched R-numbers).
function refreshedReportNoticeEmbed(embed, record, channelName) {
  const source = embed?.toJSON?.() || embed;
  if (source?.title !== 'Report update' && source?.title !== 'Moderation update') return null;
  const oldFields = source.fields || [];
  const description = oldFields.length
    ? reportNoticeDescription(source.description, oldFields.map(field => ({
      ...field,
      value: field.name === 'Review outcome' ? spacedReportOutcome(field.value) : field.value,
    })))
    : compactHighlightedReportGaps(source.description);
  const footerText = reportFooterText(record, channelName);
  if (source.description === description
      && source.footer?.text === footerText
      && oldFields.length === 0) return null;
  return new EmbedBuilder({ ...source, description, fields: [], footer: { text: footerText } });
}

function reportUpdateEmbed(record, audience, actions, messageText, channelName) {
  const reporter = audience === 'reporter';
  const removed = actions.includes('delete');
  const timedOut = actions.includes('timeout');
  const actionTaken = removed || timedOut || actions.includes('ban');
  const blue = feedEmoji('report_blue');
  const green = feedEmoji('online');
  const red = feedEmoji('offline');
  const orange = feedEmoji('report_orange');
  const duration = Number(record.actions?.timeout?.durationMs);
  const mute = duration > 0 ? `Temporary mute (${formatDuration(duration)})` : 'Temporary mute';
  const measure = removed && timedOut ? `Message removed & ${mute.charAt(0).toLowerCase()}${mute.slice(1)}`
    : timedOut ? mute : 'Message removed';
  // Photos and videos open from a link, also after the message was deleted.
  const attachmentLines = reportAttachmentLines(record.reportedAttachments);
  const attachmentText = attachmentLines.join('\n').slice(0, 700);
  const messageBody = truncateMessageLogText(escapeMarkdown(messageText.trim()), 1022 - (attachmentText ? attachmentText.length + 1 : 0));
  const reportText = [messageBody, attachmentText].filter(Boolean).join('\n') || 'No text available.';
  const thanks = 'Thank you for bringing this to our attention. We appreciate your contribution to keeping our community fair and safe.';
  const outcome = reporter
    ? actionTaken
      ? `${green} Action taken\nAppropriate action has been taken regarding the reported member in accordance with our server rules.\n${thanks}`
      : `${red} No action taken\nNo further action was deemed necessary.\n${thanks}`
    : actionTaken
      ? `${red} Action taken`
      : `${green} No action taken\nAfter reviewing the report, our team has decided that no further action is necessary at this time.`;
  const sanctionReason = ['timeout', 'delete', 'ban']
    .map(action => record.actions?.[action]?.reason)
    .find(reason => typeof reason === 'string' && reason.trim())?.trim()
    || 'No reason provided.';
  const intro = reporter
    ? `${blue} Reviewed\n\nYour report has been reviewed by our moderation team.`
    : 'Your recent message has been brought to the attention of our moderation team and has been reviewed.';
  const sections = [
    ...(reporter ? [{ name: 'Reported member', value: `<@${record.targetId}>` }] : []),
    { name: 'Reported message', value: reportText },
    { name: 'Review outcome', value: spacedReportOutcome(outcome) },
    ...(!reporter && actionTaken ? [
      { name: 'Moderation action', value: `${orange} ${measure}` },
      { name: 'Reason', value: truncateMessageLogText(escapeMarkdown(sanctionReason), 1020) },
    ] : []),
    { name: 'Auto-close', value: "You can close this notification once you've read it. Otherwise, it will be automatically deleted after 24 hours." },
  ];
  return caseEmbed({
    title: reporter ? 'Report update' : 'Moderation update',
    description: reportNoticeDescription(intro, sections),
    footer: { text: reportFooterText(record, channelName) },
    thumbnail: null,
    timestamp: false,
    preserveRuntimeEmoji: true,
  });
}

export async function publishReportOutcome(client, guild, report, record, action, actorId) {
  if (record.closedAt || (record.expiresAt && record.expiresAt <= Date.now())) throw new Error('This report has expired or was deleted.');
  const config = await getGuildConfig(client, guild.id);
  const source = report.channel || await fetchChannel(guild, record.reportChannelId);
  if (source?.permissionsFor?.(guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) throw new Error('Staff report controls require a private reports channel.');

  const actions = Array.isArray(action) ? [...new Set(action)] : [action];
  const activeAudiences = actions.includes('ban') ? ['reporter'] : audiences;
  record = await ensurePrivateCases(client, guild, report, record, config, activeAudiences);

  const messageText = reportedMessageText(record, report);

  for (const audience of activeAudiences) {
    const entry = record.cases[audience];
    if (entry.deletedAt) continue;

    const channel = await fetchChannel(guild, entry.channelId);
    // Never fall back to an old case number for the private notice. Both
    // audiences must derive the R-number from the visible channel name.
    const channelMatch = /^report-([1-9]\d*)$/i.exec(String(channel?.name || ''));
    if (!channelMatch) throw new Error('The report case channel has an invalid number.');
    const channelReportNumber = Number(channelMatch[1]);
    const existing = await fetchMessage(channel, entry.messageId);
    const participant = participantId(record, audience);
    const payload = {
      content: `<@${participant}>`,
      embeds: [reportUpdateEmbed(record, audience, actions, messageText, channel?.name)],
      components: reportCaseControls(record, false, false, audience),
      allowedMentions: { parse: [], users: [participant], roles: [] },
    };

    // Guard the final REST payload as well as the embed constructor, so
    // a global footer/template hook cannot overwrite R113 with R103/R106.
    const notice = await withReportCaseNoticeNumber(channelReportNumber, () =>
      existing?.author?.id === client.user.id ? existing.edit(payload) : channel.send(payload));
    entry.messageId = notice.id;
    entry.closeNoticeReady = true;
    await save(client, syncAliases(record));
    if (!entry.createdLogId) await publishStaffLog(client, guild, record, audience, 'created', actorId);
  }

  scheduleReportCaseExpiry(client, guild, record);
  return record;
}

function clearTimers(record) {
  const key = reportKey(record.guildId, record.messageId);
  clearTimeout(expiryTimers.get(key)); expiryTimers.delete(key);
}

export function scheduleReportCaseExpiry(client, guild, record, retryMs) {
  if ((!record.caseChannelId && !record.cases) || record.closedAt) return;
  const key = reportKey(record.guildId, record.messageId);
  clearTimeout(expiryTimers.get(key));
  const timer = setTimeout(() => {
    expiryTimers.delete(key);
    void deleteReportCase(client, guild, record).catch(error => {
      logger.warn(`Report case expiry failed: ${error.message}`);
      scheduleReportCaseExpiry(client, guild, record, 60_000);
    });
  }, retryMs ?? Math.max(0, record.expiresAt - Date.now()));
  timer.unref?.(); expiryTimers.set(key, timer);
}

export async function deleteReportCase(client, guild, record, executor = '24-hour expiry', alreadyLocked = false, audience) {
  const operation = async () => {
    record = await client.db.get(reportKey(record.guildId, record.messageId)) || record;
    if (!record.cases && record.caseChannelId) record.cases = { target: { channelId: record.caseChannelId } };
    for (const kind of audience ? [audience] : Object.keys(record.cases || {})) {
      const entry = record.cases[kind];
      if (!entry) continue;
      if (!entry.deletedAt) {
        const automatic = executor === '24-hour expiry';
        const channel = await fetchChannel(guild, entry.channelId);
        if (channel) {
          // Noted before the channel is removed, so a restart in between
          // still knows that the automatic deletion had begun.
          if (automatic && !entry.expiryStartedAt) {
            entry.expiryStartedAt = Date.now();
            await save(client, record);
          }
          await channel.delete(`Report ${record.number}: ${executor}`);
        }
        // A channel that is already gone at the 24-hour mark was removed by
        // hand in Discord. That is a closure by someone, never the automatic
        // deletion, so it is logged as closed, not as deleted.
        const removedByHand = automatic && !channel && !entry.expiryStartedAt;
        const actor = removedByHand ? 'Unknown' : executor;
        entry.deletedAt = Date.now(); entry.deletedBy = actor;
        if (actor !== '24-hour expiry') {
          entry.closedAt ||= entry.deletedAt;
          entry.closedBy = actor;
        }
        await save(client, record);
      }
    }
    if (!record.closedAt && Object.values(record.cases || {}).every(entry => entry.deletedAt)) {
      record.closedAt = Date.now();
      await save(client, record);
      clearTimers(record);
    }
    return record;
  };
  // The button handler releases its enclosing lock before delivering logs.
  if (alreadyLocked) return operation();
  const key = reportKey(record.guildId, record.messageId);
  const deleted = await withReportLock(key, operation);
  await Promise.all((audience ? [audience] : Object.keys(deleted.cases || {})).map(kind =>
    queueReportDeletePresentation(client, guild, key, kind)));
  return deleted;
}

function queueReportDeletePresentation(client, guild, key, audience) {
  const jobKey = `${key}:${audience}`;
  const ongoing = reportDeletePresentationJobs.get(jobKey);
  if (ongoing) return ongoing;
  const job = (async () => {
    const record = await client.db.get(key);
    const entry = record?.cases?.[audience];
    if (!entry?.deletedAt) return;
    if (entry.deletedBy === '24-hour expiry') {
      if (!entry.deleteLogId) await publishStaffLog(client, guild, record, audience, 'delete', entry.deletedBy, true);
    } else if (!entry.closeLogId) {
      await publishStaffLog(client, guild, record, audience, 'close', entry.closedBy || entry.deletedBy, true);
    }
  })();
  reportDeletePresentationJobs.set(jobKey, job);
  void job.finally(() => {
    if (reportDeletePresentationJobs.get(jobKey) === job) reportDeletePresentationJobs.delete(jobKey);
  }).catch(() => {});
  return job;
}

export async function handleReportCaseControl(interaction, client, [action, messageId, audience = 'target']) {
  if (!interaction.inGuild() || !['close', 'read', 'delete'].includes(action) || !audiences.includes(audience)) return;
  // A component deferUpdate acknowledges instantly without showing the
  // "Cloudy Manager is thinking..." placeholder while permissions and
  // durable case state are being updated.
  const silentAck = typeof interaction.deferUpdate === 'function'
    && typeof interaction.followUp === 'function';
  if (silentAck) {
    await interaction.deferUpdate();
  } else {
    // Preserve compatibility with legacy adapters that have no update callback.
    await interaction.deferReply({ flags: 64 });
  }
  const respondPrivately = payload => silentAck
    ? interaction.followUp({ ...payload, flags: 64 })
    : InteractionHelper.safeEditReply(interaction, payload);
  const scheduleDeletion = message => {
    const timer = setTimeout(() => {
      if (silentAck) {
        // deleteReply after deferUpdate would delete the original public report.
        const id = message?.id || message?.resource?.message?.id;
        if (id) void interaction.webhook?.deleteMessage?.(id)?.catch(() => {});
      } else {
        void interaction.deleteReply?.().catch(() => {});
      }
    }, 10_000);
    timer.unref?.();
  };
  try {
    const key = reportKey(interaction.guildId, messageId);
    const closed = await withReportLock(key, async () => {
      const actor = interaction.guild.members.cache?.get?.(interaction.user.id)
        || (interaction.member?.id === interaction.user.id && interaction.member?.roles?.cache
          ? interaction.member : null);
      const [record, config, member] = await Promise.all([
        client.db.get(key),
        getGuildConfig(client, interaction.guildId),
        actor ? Promise.resolve(actor) : interaction.guild.members.fetch(interaction.user.id),
      ]);
      const entry = record?.cases?.[audience];
      const expectedMessage = action === 'delete' ? entry?.deletePromptId : entry?.messageId;
      if (!entry || interaction.channelId !== entry.channelId || interaction.message.id !== expectedMessage
        || interaction.message.author?.id !== client.user.id) throw new Error('This report is no longer available.');
      const staff = caseStaffAllowed(interaction.guild, member, config);
      const participant = action !== 'delete' && interaction.user.id === participantId(record, audience);
      if (!staff && !participant) {
        await showReportPermissionDenied(interaction, 'Only the involved member or staff can close this report.', respondPrivately, scheduleDeletion);
        return false;
      }
      await deleteReportCase(client, interaction.guild, record, interaction.user.id, true, audience);
      return true;
    });
    if (!closed) return;
    const presentation = queueReportDeletePresentation(client, interaction.guild, key, audience);
    if (!silentAck) await interaction.deleteReply().catch(() => {});
    await presentation;
  } catch (error) {
    logger.error('Report close failed:', error);
    await respondPrivately({ content: `Error: ${error.message}` }).catch(() => {});
  }
}

// The legacy report-log cleanup only has to succeed once per case. Repeating it
// on every start re-edited every old log and kept the restore busy for about
// half an hour of rate-limited REST calls.
async function markLogControlsCleaned(client, key, audience) {
  return withReportLock(key, async () => {
    const latest = await client.db.get(key);
    const entry = latest?.cases?.[audience];
    if (!entry || entry.logControlsCleaned) return latest;
    entry.logControlsCleaned = true;
    return save(client, latest);
  });
}

// Some older #89 staff logs predate persistent case records. Locate those
// exact bot-owned messages in the private log channel and edit titles in place.
// Never repost or alter unrelated reports, audiences, fields or action details.
async function backfillUnlinkedReport89Logs(client) {
  if (!client.channels?.fetch || !client.db?.get) return;
  const key = 'global:report-log-89-title-backfill-v2';
  if (await client.db.get(key)) return;
  const logs = await client.channels.fetch(REPORT_LOG_CHANNEL_ID).catch(() => null);
  if (!logs?.messages?.fetch) return;
  const found = new Set();
  let before;
  for (let page = 0; page < 4 && found.size < 2; page++) {
    const batch = await logs.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch?.size) break;
    for (const message of batch.values()) {
      if (message.author?.id !== client.user?.id) continue;
      const embed = message.embeds?.[0];
      if (!embed || !embed.fields?.some(field => field.name === 'Report' && field.value === '#89')) continue;
      const name = embed.fields.find(field => field.name === 'Audience')?.value;
      const audience = name === 'Reporter' ? 'reporter' : name === 'Reported member' ? 'target' : null;
      if (!audience) continue;
      const expected = REPORT_LOG_TITLES[audience].created;
      if (embed.title !== expected || embed.footer?.text !== CLOUDY_STANDARD_FOOTER) {
        const revised = EmbedBuilder.from(embed).setTitle(expected);
        revised.data.footer = { text: CLOUDY_STANDARD_FOOTER };
        delete revised.data.timestamp;
        await message.edit({ embeds: [revised] });
      }
      found.add(audience);
    }
    before = batch.last()?.id;
    if (!before || batch.size < 100) break;
  }
  if (found.size === 2) await client.db.set(key, true);
  logger.info('Report #89 historical staff-log title check', { found: [...found], complete: found.size === 2 });
}
export async function restoreReportCaseTimers(client) {
  let restored = 0;
  for (const key of await client.db.list('global:report:')) {
    // A deploy can stop this process while the restore is still running; the
    // next process restores everything again, so stop instead of failing each
    // remaining case with "Expected token to be set".
    if (client.token === null) break;
    try {
      let record = await client.db.get(key);
      const guild = record && client.guilds.cache.get(record.guildId);
      if (!guild || (!record.caseChannelId && !record.cases)) continue;

      // Clean legacy report-log presentation even for already deleted cases:
      // no stale channel mentions and no Delete buttons in report-logs.
      if (record.cases) {
        for (const audience of audiences) {
          const entry = record.cases[audience];
          if (!entry) continue;
          if (!entry.reportLogPresentationV4) {
            await upgradeExistingReportLogPresentation(client, guild, record, audience);
            entry.reportLogPresentationV4 = true;
          }
          if (!entry.logControlsCleaned) {
            await refreshLogControls(client, guild, record, audience);
            await markLogControlsCleaned(client, key, audience);
            entry.logControlsCleaned = true;
          }
          // A restart can interrupt background deletion-log delivery after
          // channel deletion was saved. Resume that essential log exactly once.
          if (entry.deletedAt && (entry.deletedBy === '24-hour expiry' ? !entry.deleteLogId : !entry.closeLogId)) {
            await queueReportDeletePresentation(client, guild, key, audience);
          }
        }
      }
      if (record.closedAt) continue;

      // Keep expiry active even if repairing an older notification fails.
      scheduleReportCaseExpiry(client, guild, record);
      if (record.expiresAt > Date.now()) {
        for (const audience of audiences) {
          const entry = record.cases?.[audience];
          if (!entry?.messageId || entry.deletedAt || entry.closedAt) continue;
          const channel = await fetchChannel(guild, entry.channelId);
          const notice = await fetchMessage(channel, entry.messageId);
          if (notice?.author?.id !== client.user.id) continue;
          const refreshed = refreshedReportNoticeEmbed(notice.embeds?.[0], record, channel?.name);
          if (refreshed) await notice.edit({ embeds: [refreshed] });
          if (entry.closeNoticeReady) continue;
          const embeds = (refreshed ? [refreshed] : notice.embeds).map(embed =>
            setPreservedEmbedColor(EmbedBuilder.from(embed), 0xFFFFFF));
          await notice.edit({ embeds, components: reportCaseControls(record, false, false, audience) });
          await saveCasePresentationField(client, key, audience, 'closeNoticeReady', true);
        }
      }
      if (!record.cases && record.expiresAt > Date.now()) {
        const completed = Object.entries(record.actions || {}).filter(([, outcome]) =>
          outcome.status === 'completed');
        if (completed.length) {
          const source = await fetchChannel(guild, record.reportChannelId);
          const actions = completed.map(([name]) => name);
          const actorId = completed[0][1].actorId;
          const originalReport = await fetchMessage(source, record.messageId);
          record = await publishReportOutcome(client, guild, originalReport || { channel: source }, record, actions, actorId);
          for (const [name, outcome] of completed) {
            record.actions[name] = { ...outcome, notified: true };
          }
          record.handledAt = Math.max(...completed.map(([, outcome]) => Number(outcome.completedAt) || Date.now()));
          record.handledBy = actorId;
          record.handledActions = actions;
          await save(client, record);
        }
      }
      scheduleReportCaseExpiry(client, guild, record); restored++;
    } catch (error) { logger.warn(`Report case restore failed: ${error.message}`); }
  }
  await backfillUnlinkedReport89Logs(client).catch(error => logger.warn('Report #89 staff-log backfill failed: ' + error.message));
  startupLog(`Report case expiry restored: ${restored} active case(s).`);
}
