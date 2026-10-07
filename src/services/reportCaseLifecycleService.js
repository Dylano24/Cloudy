// CLOUDY_INTERACTION_LATENCY_V1
import { performance } from 'node:perf_hooks';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { buildStandardLogEmbed } from '../utils/logging/logEmbeds.js';
import { CLOUDY_STANDARD_FOOTER } from '../utils/cloudyFooter.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../utils/embedColorPolicy.js';
import { TICKET_EVENT_STYLES } from '../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger, startupLog } from '../utils/logger.js';
import { reportKey, withReportLock, reportStaffRole, caseStaffAllowed, nextReportNumber, reportCaseControls, REPORT_CATEGORY_ID, REPORT_CASE_MS } from './reportCaseService.js';

export const REPORT_LOG_CHANNEL_ID = '1556344268099166319';
const expiryTimers = new Map();
const audiences = ['reporter', 'target'];
const reportReadPresentationJobs = new Map();

function caseEmbed(data) {
  const embed = buildStandardLogEmbed({ ...data, color: null, footer: { text: CLOUDY_STANDARD_FOOTER }, thumbnail: CLOUDY_LOGO_URL });
  setPreservedEmbedColor(embed, data.color ?? 0xFFFFFF);
  return embed;
}

async function save(client, record) {
  if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) throw new Error('The report could not be saved.');
  return record;
}

// Persist one presentation field against the latest case. Long Discord REST
// calls must never hold the report lock or overwrite a second Read.
async function saveReadPresentationField(client, key, audience, field, value) {
  return withReportLock(key, async () => {
    const latest = await client.db.get(key);
    if (!latest?.cases?.[audience] || latest.cases[audience].deletedAt) return latest;
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

function privateDeleteControls(record, audience, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_case:delete:${record.messageId}:${audience}`)
      .setLabel('Delete').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

function deleteCaseEmbed(record, audience) {
  const entry = record.cases?.[audience];
  const readBy = entry?.closedBy ? `<@${entry.closedBy}>` : 'Unknown';
  return caseEmbed({
    title: 'Delete report',
    description: `This report has been read by ${readBy}.`,
    color: CLOUDY_RED_COLOR,
    fields: [{ name: 'Report', value: `#${record.number}`, inline: true }],
  });
}

async function ensurePrivateDeletePrompt(client, channel, record, audience) {
  const entry = record.cases[audience];
  const existing = await fetchMessage(channel, entry.deletePromptId);
  const payload = {
    content: null,
    embeds: [deleteCaseEmbed(record, audience)],
    components: privateDeleteControls(record, audience),
    allowedMentions: { parse: [] },
  };
  const message = existing?.author?.id === client.user.id
    ? await existing.edit(payload)
    : await channel.send(payload);
  entry.deletePromptId = message.id;
  await saveReadPresentationField(
    client, reportKey(record.guildId, record.messageId), audience, 'deletePromptId', message.id,
  );
  return message;
}

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
  const title = event === 'close' ? 'Report closed' : event === 'delete' ? 'Report deleted' : 'Report created';
  const fields = [{ name: 'Report', value: `#${record.number}`, inline: true },
    { name: 'Member', value: `<@${participantId(record, audience)}>`, inline: true },
    { name: event === 'close' ? 'Closed by' : event === 'delete' ? 'Deleted by' : 'Handled by', value: actorId === '24-hour expiry' ? 'Automatic · 24-hour expiry' : `<@${actorId}>`, inline: true },
    { name: 'Audience', value: audience === 'reporter' ? 'Reporter' : 'Reported member', inline: true }];
  const embed = caseEmbed({ title, fields });
  if (event === 'close' || event === 'delete') setPreservedEmbedColor(embed, TICKET_EVENT_STYLES[event].color);
  return embed;
}

async function publishStaffLog(client, guild, record, audience, event, actorId, persistRead = false) {
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
  if (persistRead) {
    return saveReadPresentationField(client, reportKey(record.guildId, record.messageId), audience, key, message.id);
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
      embeds: [logEmbed(record, audience, 'delete', entry.deletedBy || '24-hour expiry')],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

export async function publishReportOutcome(client, guild, report, record, action, actorId, reason) {
  if (record.closedAt || (record.expiresAt && record.expiresAt <= Date.now())) throw new Error('This report has expired or was deleted.');
  const config = await getGuildConfig(client, guild.id);
  const source = report.channel || await fetchChannel(guild, record.reportChannelId);
  if (source?.permissionsFor?.(guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) throw new Error('Staff report controls require a private reports channel.');

  const actions = Array.isArray(action) ? [...new Set(action)] : [action];
  const activeAudiences = actions.includes('ban') ? ['reporter'] : audiences;
  record = await ensurePrivateCases(client, guild, report, record, config, activeAudiences);

  const actionText = actions.map(name => ({
    delete: 'The reported message has been deleted.',
    timeout: 'The reported member has been timed out.',
    ban: 'The reported member has been banned.',
    no_sanction: 'The report was reviewed and no sanction was applied.',
  })[name]).filter(Boolean).join('\n');

  const targetActionText = (() => {
    const actionSet = new Set(actions);
    if (actionSet.has('delete') && actionSet.has('timeout')) {
      return 'A message you sent was reported and has been removed by our staff. You have also been timed out.';
    }
    if (actionSet.size === 1 && actionSet.has('delete')) {
      return 'A message you sent was reported and has been removed by our staff.';
    }
    if (actionSet.size === 1 && actionSet.has('timeout')) {
      return 'A report involving you has been reviewed by our staff and you have been timed out.';
    }
    if (actionSet.size === 1 && actionSet.has('no_sanction')) {
      return 'A report about you has been reviewed by our staff, and no sanction was applied.';
    }
    return actionText;
  })();

  for (const audience of activeAudiences) {
    const entry = record.cases[audience];
    if (entry.deletedAt) continue;

    const channel = await fetchChannel(guild, entry.channelId);
    const existing = await fetchMessage(channel, entry.messageId);
    const participant = participantId(record, audience);
    const showReason = audience === 'target' && !actions.includes('no_sanction');
    const fields = [
      { name: 'Report', value: `#${record.number}`, inline: true },
      ...(showReason ? [{ name: 'Reason', value: reason || 'No reason recorded' }] : []),
      { name: 'Automatic deletion', value: 'This report notification will be automatically deleted after 24 hours.' },
    ];

    const payload = {
      content: `<@${participant}>`,
      embeds: [caseEmbed({
        title: 'Report notification',
        description: audience === 'target' ? targetActionText : actionText,
        color: 0x00C49D,
        fields,
      })],
      components: reportCaseControls(record, false, Boolean(entry.closedAt), audience),
      allowedMentions: { parse: [], users: [participant], roles: [] },
    };

    const notice = existing?.author?.id === client.user.id ? await existing.edit(payload) : await channel.send(payload);
    entry.messageId = notice.id;
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
        await save(client, record);
      }
      if (!entry.deleteLogId) await publishStaffLog(client, guild, record, kind, 'delete', entry.deletedBy || executor);
      await refreshLogControls(client, guild, record, kind);
    }
    if (Object.values(record.cases || {}).every(entry => entry.deletedAt)) {
      record.closedAt = Date.now();
      await save(client, record);
      clearTimers(record);
    }
  };
  return alreadyLocked ? operation() : withReportLock(reportKey(record.guildId, record.messageId), operation);
}

async function revokeReportParticipantAccess(channel, guild, userId, knownMember = null) {
  const permissions = {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false,
  };

  const member = (knownMember?.id === userId ? knownMember : null)
    || guild.members.cache?.get?.(userId)
    || await guild.members.fetch(userId).catch(() => null);

  if (member) {
    await channel.permissionOverwrites.edit(member, permissions);
    return;
  }

  const existing = channel.permissionOverwrites.cache?.get?.(userId);
  if (existing?.edit) {
    await existing.edit(permissions);
  }
  // If the member has left and no overwrite remains, they already have no
  // participant access to revoke. Treat that as successfully closed.
}

// Expensive Discord presentation is separate from the tiny durable Read
// transaction. A second audience must never queue behind log fetches/edits
// from the first audience of the same report.
async function finishReportReadPresentation(client, guild, key, audience, notice, currentChannel) {
  const record = await client.db.get(key);
  const entry = record?.cases?.[audience];
  if (!entry?.closedAt || entry.deletedAt || record.closedAt) return;

  const channel = currentChannel?.id === entry.channelId
    ? currentChannel : await fetchChannel(guild, entry.channelId);
  if (!channel) return;

  const jobs = [
    ensurePrivateDeletePrompt(client, channel, record, audience),
  ];
  if (notice?.author?.id === client.user.id) {
    jobs.push(notice.edit({
      components: reportCaseControls(record, false, true, audience, true),
      allowedMentions: { parse: [] },
    }));
  }
  if (!entry.closeLogId) {
    jobs.push(publishStaffLog(
      client, guild, record, audience, 'close', entry.closedBy, true,
    ));
  }
  // These Discord messages are independent. Store each resulting ID with a
  // short locked, field-specific write; never persist a stale entire record.
  await Promise.all(jobs);
  const latest = await client.db.get(key);
  if (latest?.cases?.[audience]) {
    await refreshLogControls(client, guild, latest, audience);
  }
}

function queueReportReadPresentation(client, guild, key, audience, notice, channel) {
  const jobKey = `${key}:${audience}`;
  const ongoing = reportReadPresentationJobs.get(jobKey);
  if (ongoing) return ongoing;
  const job = finishReportReadPresentation(client, guild, key, audience, notice, channel);
  reportReadPresentationJobs.set(jobKey, job);
  void job.finally(() => {
    if (reportReadPresentationJobs.get(jobKey) === job) {
      reportReadPresentationJobs.delete(jobKey);
    }
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
  const started = performance.now();
  let lastStage = started;
  const stages = [];
  const mark = stage => {
    if (action !== 'read') return;
    const now = performance.now();
    stages.push({ stage, ms: Math.round(now - lastStage) });
    lastStage = now;
  };
  mark('ack');
  let keepReply = false;
  const confirmRead = async () => {
    if (action !== 'read' || keepReply) return;
    keepReply = true;
    const message = await respondPrivately({
      content: null,
      embeds: [caseEmbed({
        title: 'Thank you.',
        description: 'We have been informed that you have read this report.',
        color: CLOUDY_GREEN_COLOR,
      })],
      components: [],
      allowedMentions: { parse: [] },
    });
    scheduleDeletion(message);
  };
  try {
    const key = reportKey(interaction.guildId, messageId);
    let shouldPresentRead = false;
    await withReportLock(key, async () => {
      const record = await client.db.get(key);
      mark('case_lookup');
      const entry = record?.cases?.[audience];
      if (!entry || record.closedAt || entry.deletedAt || interaction.message.author?.id !== client.user.id) throw new Error('This report is no longer available.');
      // Discord already supplied the actor on this interaction. Reuse a real
      // GuildMember instead of serializing another Discord member lookup.
      const actor = interaction.guild.members.cache?.get?.(interaction.user.id)
        || (interaction.member?.id === interaction.user.id && interaction.member?.roles?.cache
          ? interaction.member : null);
      const [config, member] = await Promise.all([
        getGuildConfig(client, interaction.guildId),
        actor ? Promise.resolve(actor) : interaction.guild.members.fetch(interaction.user.id),
      ]);
      mark('actor_and_config');
      const staff = caseStaffAllowed(interaction.guild, member, config);
      const inCase = interaction.channelId === entry.channelId && interaction.message.id === entry.messageId;
      const inDeletePrompt = interaction.channelId === entry.channelId && interaction.message.id === entry.deletePromptId;

      if (action === 'delete') {
        if (!inDeletePrompt || !entry.closedAt) throw new Error('Delete report is only available after the report is closed.');
        if (!staff) {
          keepReply = true;
          await showReportPermissionDenied(interaction, 'Only the staff can delete this report.', respondPrivately, scheduleDeletion);
          return;
        }
        await deleteReportCase(client, interaction.guild, record, interaction.user.id, true, audience);
        return;
      }

      if (!inCase) throw new Error('You cannot use these report controls.');
      if (!staff && interaction.user.id !== participantId(record, audience)) throw new Error('Only the involved member or staff can mark this report as read.');

      // Read keeps Staff access, removes the participant's access and exposes
      // Delete report only inside the private report channel.
      if (!entry.closedAt) {
        const channel = interaction.channel?.id === entry.channelId
          ? interaction.channel : await fetchChannel(interaction.guild, entry.channelId);
        const participantIdValue = participantId(record, audience);
        const participant = (member?.id === participantIdValue ? member : null)
          || interaction.guild.members.cache?.get?.(participantIdValue)
          || await interaction.guild.members.fetch(participantIdValue).catch(() => null);
        mark('participant_lookup');
        if (!caseStaffAllowed(interaction.guild, participant, config)) {
          await revokeReportParticipantAccess(channel, interaction.guild, participantIdValue, participant);
        }
        mark('permissions');
        entry.closedAt = Date.now();
        entry.closedBy = interaction.user.id;
        await save(client, record);
        mark('persist');

      }

      // Only authorization, access revocation and the durable close belong
      // under the per-report lock. Slow message/log presentation must not.
      shouldPresentRead = action === 'read';
    });
    mark('lock_released');
    if (shouldPresentRead) {
      // The same private success response is sent only after the report was
      // durably marked read and its participant permissions were revoked.
      await confirmRead();
      mark('confirmation');
      const presentation = queueReportReadPresentation(
        client, interaction.guild, key, audience, interaction.message, interaction.channel,
      );
      if (silentAck) {
        // The private success embed is already delivered and access is revoked.
        // Staff logs and the red Delete prompt are essential, but their Discord
        // REST calls must never hold the user's handler or next 100 interactions.
        void presentation.catch(error => {
          logger.error('[REPORT_READ_PRESENTATION] Failed to finish staff presentation:', error);
        });
      } else {
        // Older adapters without component follow-ups retain their original
        // completion contract (also used by legacy test fixtures).
        await presentation;
      }
    }
    if (!keepReply && !silentAck) await interaction.deleteReply().catch(() => {});
  } catch (error) { await respondPrivately({ content: `Error: ${error.message}` }); }
  finally {
    if (action === 'read' && performance.now() - started >= 750) {
      mark('remaining_updates');
      logger.warn(`[REPORT_READ_STAGES] ${JSON.stringify({
        elapsedMs: Math.round(performance.now() - started), stages,
      })}`);
    }
  }
}

export async function restoreReportCaseTimers(client) {
  let restored = 0;
  for (const key of await client.db.list('global:report:')) {
    try {
      let record = await client.db.get(key);
      const guild = record && client.guilds.cache.get(record.guildId);
      if (!guild || (!record.caseChannelId && !record.cases)) continue;

      // Clean legacy report-log presentation even for already deleted cases:
      // no stale channel mentions and no Delete buttons in report-logs.
      if (record.cases) {
        for (const audience of audiences) {
          if (record.cases[audience]) await refreshLogControls(client, guild, record, audience);
        }
      }
      if (record.closedAt) continue;

      // Keep expiry active even if repairing an older notification fails.
      scheduleReportCaseExpiry(client, guild, record);
      if (!record.cases && record.expiresAt > Date.now()) {
        const completed = Object.entries(record.actions || {}).filter(([, outcome]) =>
          outcome.status === 'completed');
        if (completed.length) {
          const source = await fetchChannel(guild, record.reportChannelId);
          const actions = completed.map(([name]) => name);
          const actorId = completed[0][1].actorId;
          const reason = completed[0][1].reason;
          record = await publishReportOutcome(client, guild, { channel: source }, record, actions, actorId, reason);
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
