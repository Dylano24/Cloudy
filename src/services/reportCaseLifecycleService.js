// CLOUDY_INTERACTION_LATENCY_V1
import { EmbedBuilder, escapeMarkdown, ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { formatDuration } from '../utils/embeds.js';
import { truncateMessageLogText } from '../utils/logging/preserveMessageText.js';
import { REPORT_MODERATION_FOOTER } from '../utils/reportCasePrivacy.js';
import { feedEmoji } from './feedEmojiService.js';
import { getGuildConfig } from './config/guildConfig.js';
import { buildStandardLogEmbed } from '../utils/logging/logEmbeds.js';
import { CLOUDY_STANDARD_FOOTER } from '../utils/cloudyFooter.js';
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
  const embed = buildStandardLogEmbed({ ...data, color: null, footer: data.footer || { text: CLOUDY_STANDARD_FOOTER }, thumbnail: CLOUDY_LOGO_URL });
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
    if (latest.cases[audience].deletedAt && !field.endsWith('LogId')) return latest;
    latest.cases[audience][field] = value;
    return save(client, latest);
  });
}

async function fetchChannel(guild, id) {
  if (!id) return null;
  return guild.channels.fetch(id).catch(error => { if (error.code === 10003) return null; throw error; });
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

function logEmbed(record, audience, event, actorId) {
  const title = event === 'close' ? 'Report closed' : event === 'delete' ? 'Report automatically deleted' : 'Report created';
  const fields = [{ name: 'Report', value: `#${record.number}`, inline: true },
    { name: 'Member', value: `<@${participantId(record, audience)}>`, inline: true },
    { name: event === 'close' ? 'Closed by' : event === 'delete' ? 'Reason' : 'Handled by', value: event === 'delete' ? 'Automatic · 24-hour expiry' : `<@${actorId}>`, inline: true },
    { name: 'Audience', value: audience === 'reporter' ? 'Reporter' : 'Reported member', inline: true }];
  const embed = caseEmbed({ title, fields });
  if (event === 'close' || event === 'delete') setPreservedEmbedColor(embed, TICKET_EVENT_STYLES[event].color);
  return embed;
}

async function publishStaffLog(client, guild, record, audience, event, actorId, persistField = false) {
  const logs = await fetchChannel(guild, REPORT_LOG_CHANNEL_ID);
  if (!logs?.send) throw new Error('The report-logs channel is unavailable.');
  const entry = record.cases[audience];
  const key = event === 'close' ? 'closeLogId' : event === 'delete' ? 'deleteLogId' : 'createdLogId';
  const existing = await fetchMessage(logs, entry[key]);
  const payload = { content: null,
    embeds: [logEmbed(record, audience, event, actorId)],
    components: [],
    allowedMentions: { parse: [] } };
  const message = existing?.author?.id === client.user.id ? await existing.edit(payload) : await logs.send(payload);
  entry[key] = message.id;
  if (persistField) {
    return saveCasePresentationField(client, reportKey(record.guildId, record.messageId), audience, key, message.id);
  }
  await save(client, record);
  return record;
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
    await closed.edit({
      content: null,
      embeds: [logEmbed(record, audience, 'close', entry.closedBy || 'Unknown')],
      components: [],
      allowedMentions: { parse: [] },
    });
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

function reportUpdateEmbed(record, audience, actions, messageText) {
  const reporter = audience === 'reporter';
  const removed = actions.includes('delete');
  const timedOut = actions.includes('timeout');
  const actionTaken = removed || timedOut || actions.includes('ban');
  const green = feedEmoji('online') || '🟢';
  const red = feedEmoji('offline') || '🔴';
  const duration = Number(record.actions?.timeout?.durationMs);
  const mute = duration > 0 ? `Temporary mute (${formatDuration(duration)})` : 'Temporary mute';
  const measure = timedOut ? (removed ? `Message removed & ${mute.toLowerCase()}` : mute) : 'Message removed';
  const outcome = reporter
    ? actionTaken
      ? `${green} Action taken\n\nAppropriate action has been taken regarding the reported member in accordance with our server rules.`
      : `${red} No action taken\n\nNo further action was deemed necessary.`
    : actionTaken
      ? `${red} Action taken\n\n🟠 ${measure}`
      : `${green} No action taken\n\nAfter reviewing the report, our team has decided that no further action is necessary at this time.`;
  return caseEmbed({
    title: `${reporter ? 'Report' : 'Moderation'} n•${record.number} update`,
    description: reporter
      ? '🔵 Reviewed\n\nYour report has been reviewed by our moderation team.'
      : 'Your recent message has been brought to the attention of our moderation team and has been reviewed.',
    fields: [
      ...(reporter ? [{ name: 'Reported member', value: `<@${record.targetId}>` }] : []),
      { name: 'Reported message', value: truncateMessageLogText(escapeMarkdown(messageText.trim()), 1024) || 'No text available.' },
      { name: reporter || actionTaken ? 'Outcome' : 'Review outcome', value: reporter
        ? outcome + '\n\nThank you for bringing this to our attention. We appreciate your contribution to keeping our community fair and safe.'
        : outcome },
      { name: 'Auto-close', value: "You can close this notification once you've read it. Otherwise, it will be automatically deleted after 24 hours." },
    ],
    footer: { text: REPORT_MODERATION_FOOTER },
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
    const existing = await fetchMessage(channel, entry.messageId);
    const participant = participantId(record, audience);
    const payload = {
      content: `<@${participant}>`,
      embeds: [reportUpdateEmbed(record, audience, actions, messageText)],
      components: reportCaseControls(record, false, false, audience),
      allowedMentions: { parse: [], users: [participant], roles: [] },
    };

    const notice = existing?.author?.id === client.user.id ? await existing.edit(payload) : await channel.send(payload);
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
        const channel = await fetchChannel(guild, entry.channelId);
        if (channel) await channel.delete(`Report ${record.number}: ${executor}`);
        entry.deletedAt = Date.now(); entry.deletedBy = executor;
        if (executor !== '24-hour expiry') {
          entry.closedAt ||= entry.deletedAt;
          entry.closedBy = executor;
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
          if (!entry?.messageId || entry.deletedAt || entry.closedAt || entry.closeNoticeReady) continue;
          const notice = await fetchMessage(await fetchChannel(guild, entry.channelId), entry.messageId);
          if (notice?.author?.id !== client.user.id) continue;
          const embeds = notice.embeds.map(embed => setPreservedEmbedColor(EmbedBuilder.from(embed), 0xFFFFFF));
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
  startupLog(`Report case expiry restored: ${restored} active case(s).`);
}
