import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { createEmbed } from '../utils/embeds.js';
import { loadReport, publishReportOutcome, reportKey, withReportLock, validateReportDestinations } from './reportCaseService.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { withCloudyFooter } from '../utils/cloudyFooter.js';

const CLOUDY_APPEAL_URL = 'https://cloudy-store-vert.vercel.app/appeal';

const REPORT_ACTIONS = {
  delete: ['delete'],
  timeout: ['timeout'],
  ban: ['ban'],
  no_sanction: ['no_sanction'],
  delete_timeout: ['delete', 'timeout'],
  delete_ban: ['delete', 'ban'],
};

const ACTION_TITLES = {
  delete: 'Delete reported message',
  timeout: 'Timeout reported member',
  ban: 'Ban reported member',
  no_sanction: 'No sanction',
  delete_timeout: 'Delete + timeout',
  delete_ban: 'Delete + ban',
};

const ACTION_TEXT = {
  delete: 'The reported message has been deleted.',
  timeout: 'The reported member has been timed out.',
  ban: 'The reported member has been banned.',
  no_sanction: 'The report was reviewed and no sanction was applied.',
};

export function reportActionsFor(action) {
  return REPORT_ACTIONS[action] || [];
}

export function reportActionText(actions) {
  return [...new Set(actions)].map(action => ACTION_TEXT[action]).filter(Boolean).join('\n');
}

export function buildReportActions(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report_action:delete:${userId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`report_action:timeout:${userId}`).setLabel('Timeout').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`report_action:ban:${userId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`report_action:no_sanction:${userId}`).setLabel('No sanction').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report_action:delete_timeout:${userId}`).setLabel('Delete + timeout').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`report_action:delete_ban:${userId}`).setLabel('Delete + ban').setStyle(ButtonStyle.Danger),
    ),
  ];
}

export function reportActionAllowed(interaction, action, config = {}) {
  const actions = reportActionsFor(action);
  if (actions.length > 1) return actions.every(item => reportActionAllowed(interaction, item, config));

  const hasOwnerRole = hasCloudyOwnerMember(interaction.member);
  if (action === 'ban') return hasOwnerRole;

  const staffId = config.ticketStaffRoleId || interaction.guild.roles?.cache?.find(
    role => role.name.trim().toLowerCase() === 'staff',
  )?.id;
  const permission = action === 'timeout'
    ? PermissionFlagsBits.ModerateMembers
    : PermissionFlagsBits.ManageMessages;

  return hasOwnerRole || Boolean(interaction.member?.permissions?.has?.(permission))
    || Boolean(staffId && interaction.member?.roles?.cache?.has?.(staffId));
}

export function timeoutDuration(value) {
  if (!/^\d+$/.test(String(value).trim())) throw new Error('Enter a whole number of minutes.');
  const minutes = Number(value);
  if (minutes < 1 || minutes > 40_320) throw new Error('Timeout must be between 1 and 40320 minutes.');
  return minutes * 60_000;
}

async function deny(interaction, message) {
  const embed = createEmbed({
    title: 'Permission denied',
    description: message,
    color: 'error',
  }).setTitle('Permission denied');

  const response = await InteractionHelper.universalReply(interaction, {
    flags: MessageFlags.Ephemeral,
    embeds: [embed],
  });

  const timer = setTimeout(() => interaction.deleteReply?.().catch(() => {}), 10_000);
  timer.unref?.();
  return response;
}

export function reportBanNotification(reason) {
  return withCloudyFooter({
    embeds: [createEmbed({
      title: 'You have been banned from the Cloudy server',
      description: `**Reason**\n${reason}\n\nIf you believe this sanction was incorrect or you would like us to review it, you can always submit an appeal using our appeal form.\n\n**Appeal:** [Cloudy appeal form](${CLOUDY_APPEAL_URL})`,
    })],
    allowedMentions: { parse: [] },
  });
}

function reportHandledEmbed(actions, record, actorId, handledAt) {
  return createEmbed({
    title: 'Report handled',
    description: reportActionText(actions),
    color: 'success',
    fields: [
      { name: `Report #${record.number}`, value: '\u200B', inline: true },
      { name: 'Handled by', value: `<@${actorId}>`, inline: true },
      { name: 'Handled at', value: `<t:${Math.floor(handledAt / 1000)}:F>`, inline: false },
    ],
  });
}

export async function handleReportAction(interaction, client, [action, userId]) {
  const actions = reportActionsFor(action);
  if (!interaction.inGuild() || !actions.length) return;
  if (interaction.message?.author?.id !== client.user.id) return;

  if (actions.includes('ban') && !reportActionAllowed(interaction, action)) {
    return deny(interaction, 'Only owners can ban members from reports.');
  }

  const modal = new ModalBuilder()
    .setCustomId(`report_moderate:${action}:${userId}:${interaction.message.id}`)
    .setTitle(ACTION_TITLES[action]);

  if (actions.includes('timeout')) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('minutes')
        .setLabel('Duration in minutes')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(5),
    ));
  }

  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('reason')
      .setLabel(action === 'no_sanction' ? 'Review note' : 'Reason')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(512),
  ));

  await interaction.showModal(modal);
}

export async function handleReportModeration(interaction, client, [action, userId, messageId]) {
  const actions = reportActionsFor(action);
  if (!interaction.inGuild() || !actions.length) return;
  if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) return;

  const config = await getGuildConfig(client, interaction.guildId);
  if (!reportActionAllowed(interaction, action, config)) {
    return deny(interaction, actions.includes('ban')
      ? 'Only owners can ban members from reports.'
      : 'Only the staff team can manage reports.');
  }

  const report = await interaction.channel.messages.fetch(messageId).catch(() => null);
  const ids = report?.components?.flatMap(row => row.components.map(button => button.customId)) || [];
  if (report?.author?.id !== client.user.id || !ids.includes(`report_action:${action}:${userId}`)) {
    return deny(interaction, 'This report is no longer available.');
  }

  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return deny(interaction, 'Please provide a reason.');

  if (actions.some(item => item === 'timeout' || item === 'ban')
    && [interaction.user.id, client.user.id, interaction.guild.ownerId].includes(userId)) {
    return deny(interaction, 'You cannot moderate yourself, Cloudy, or the server owner.');
  }

  const completed = await completeReportAction(interaction, client, report, action, userId, reason);
  const handledAt = completed.handledAt || Date.now();
  const handledActions = completed.handledActions || actions;

  await interaction.channel.send({
    embeds: [reportHandledEmbed(handledActions, completed, interaction.user.id, handledAt)],
    allowedMentions: { parse: [] },
  });

  await interaction.deleteReply().catch(() => {});
}

async function completeReportAction(interaction, client, report, action, userId, reason) {
  const requestedActions = reportActionsFor(action);

  return withReportLock(reportKey(interaction.guildId, report.id), async () => {
    const record = await loadReport(client, interaction.guild, report, userId);
    if (record.closedAt || (record.expiresAt && record.expiresAt <= Date.now())) {
      throw new Error('This report case has already closed.');
    }

    const completedNames = Object.entries(record.actions || {})
      .filter(([, outcome]) => outcome?.status === 'completed' || outcome?.notified)
      .map(([name]) => name);
    const failedSanctionNames = Object.entries(record.actions || {})
      .filter(([name, outcome]) => ['timeout', 'ban'].includes(name) && outcome?.status === 'failed')
      .map(([name]) => name);
    const recoveringPartialDeleteWithNoSanction = requestedActions.length === 1
      && requestedActions[0] === 'no_sanction'
      && completedNames.length > 0
      && completedNames.every(name => name === 'delete')
      && failedSanctionNames.length > 0;

    const completedOutsideRequest = Object.entries(record.actions || {}).find(([name, outcome]) =>
      !requestedActions.includes(name) && (outcome?.status === 'completed' || outcome?.notified));

    if (completedOutsideRequest && !recoveringPartialDeleteWithNoSanction) {
      if (report.components?.length) await report.edit({ components: [] });
      throw new Error('This report has already been handled.');
    }

    if (requestedActions.every(name => record.actions?.[name]?.notified)) {
      if (report.components?.length) await report.edit({ components: [] });
      throw new Error('This report action has already been completed.');
    }

    for (const name of requestedActions) {
      if (record.actions?.[name]?.status === 'processing') {
        throw new Error('This action is being processed. Staff must verify its outcome before retrying.');
      }
    }

    await validateReportDestinations(interaction.guild);
    const reportsChannel = report.channel || await interaction.guild.channels.fetch(record.reportChannelId);
    if (reportsChannel.permissionsFor?.(interaction.guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) {
      throw new Error('Staff report controls require a private reports channel.');
    }

    const config = await getGuildConfig(client, interaction.guildId);
    const freshMember = await interaction.guild.members.fetch(interaction.user.id);
    if (!reportActionAllowed({ guild: interaction.guild, user: interaction.user, member: freshMember }, action, config)) {
      throw new Error(requestedActions.includes('ban')
        ? 'Only owners can ban members from reports.'
        : 'Only authorized staff can perform this action.');
    }

    const durationMs = requestedActions.includes('timeout')
      ? timeoutDuration(interaction.fields.getTextInputValue('minutes'))
      : null;

    // Resolve every prerequisite before mutating anything. This prevents a
    // combined action such as Delete + timeout from deleting the message first
    // and only then discovering that the member cannot be timed out.
    let targetMember = null;
    if (requestedActions.includes('timeout') && record.actions?.timeout?.status !== 'completed') {
      targetMember = interaction.guild.members.cache?.get?.(userId)
        || await interaction.guild.members.fetch(userId).catch(() => null);
      if (!targetMember) {
        const error = new Error('The reported member is no longer in this server.');
        error.userMessage = 'The reported member is no longer in this server, so Timeout cannot be applied.';
        error.context = { expected: true };
        throw error;
      }
    }

    let targetUser = null;
    if (requestedActions.includes('ban') && record.actions?.ban?.status !== 'completed') {
      targetMember = interaction.guild.members.cache?.get?.(userId)
        || await interaction.guild.members.fetch(userId).catch(() => null);
      targetUser = targetMember?.user || await client.users.fetch(userId).catch(() => null);
      if (!targetUser) {
        const error = new Error('The reported user could not be resolved for Ban.');
        error.userMessage = 'Cloudy could not resolve the reported user, so Ban was not applied.';
        error.context = { expected: true };
        throw error;
      }
    }

    let original = null;
    if (requestedActions.includes('delete') && record.actions?.delete?.status !== 'completed') {
      if (!record.sourceChannelId || !record.sourceMessageId) {
        const error = new Error('This report has no original message linked to Delete.');
        error.userMessage = 'This report has no original message linked to Delete.';
        error.context = { expected: true };
        throw error;
      }
      const source = interaction.guild.channels.cache.get(record.sourceChannelId)
        || await interaction.guild.channels.fetch(record.sourceChannelId).catch(() => null);
      original = source?.messages?.cache?.get?.(record.sourceMessageId)
        || await source?.messages?.fetch?.(record.sourceMessageId).catch(() => null);
      if (!original) {
        const error = new Error('The reported message no longer exists.');
        error.userMessage = 'The reported message no longer exists, so Delete was not applied.';
        error.context = { expected: true };
        throw error;
      }
    }

    for (const name of requestedActions) {
      const previous = record.actions?.[name];
      if (previous?.status === 'completed') continue;

      const pending = {
        status: 'processing',
        actorId: interaction.user.id,
        reason,
        durationMs: name === 'timeout' ? durationMs : null,
      };

      record.actions = { ...record.actions, [name]: pending };
      if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) {
        throw new Error('The report action could not be saved.');
      }

      try {
        if (name === 'delete') {
          rememberMessageDeleter(original, interaction.user);
          await original.delete();
        } else if (name === 'timeout') {
          await ModerationService.timeoutUser({
            guild: interaction.guild,
            member: targetMember,
            moderator: freshMember,
            durationMs,
            reason,
          });
        } else if (name === 'ban') {
          await ModerationService.banUser({
            guild: interaction.guild,
            user: targetUser,
            moderator: freshMember,
            reason,
            notifyBeforeBan: true,
            notificationPayload: reportBanNotification(reason),
          });
        }
      } catch (error) {
        record.actions[name] = { ...pending, status: 'failed' };
        await client.db.set(reportKey(record.guildId, record.messageId), record);
        throw error;
      }

      record.actions[name] = { ...pending, status: 'completed', completedAt: Date.now() };
      if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) {
        throw new Error('The action completed but saving it failed. Do not repeat the action.');
      }
    }

    if (report.components?.length) await report.edit({ components: [] });

    const actorId = interaction.user.id;
    const outcomeActions = recoveringPartialDeleteWithNoSanction
      ? ['delete', 'no_sanction']
      : requestedActions;
    const handledAt = Math.max(
      Date.now(),
      ...outcomeActions.map(name => Number(record.actions?.[name]?.completedAt) || 0),
    );

    const notified = await publishReportOutcome(
      client,
      interaction.guild,
      report,
      record,
      outcomeActions,
      actorId,
      reason,
    );

    for (const name of outcomeActions) {
      notified.actions[name] = { ...notified.actions[name], notified: true };
    }
    notified.handledAt = handledAt;
    notified.handledBy = actorId;
    notified.handledActions = outcomeActions;

    if (await client.db.set(reportKey(record.guildId, record.messageId), notified) === false) {
      throw new Error('The action notification could not be saved.');
    }

    return notified;
  });
}
