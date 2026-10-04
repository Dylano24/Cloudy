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

export function buildReportActions(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_action:delete:${userId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`report_action:timeout:${userId}`).setLabel('Timeout').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report_action:ban:${userId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
  )];
}

export function reportActionAllowed(interaction, action, config = {}) {
  const hasOwnerRole = hasCloudyOwnerMember(interaction.member);
  if (action === 'ban') return hasOwnerRole;
  const staffId = config.ticketStaffRoleId || interaction.guild.roles?.cache?.find(
    role => role.name.trim().toLowerCase() === 'staff',
  )?.id;
  const permission = action === 'timeout' ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.ManageMessages;
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
  return InteractionHelper.universalReply(interaction, {
    flags: MessageFlags.Ephemeral, embeds: [createEmbed({ title: 'Permission denied', description: message })],
  });
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

function reportSuccessEmbed(action, record) {
  const description = {
    delete: 'The reported message has been deleted.',
    timeout: 'The reported member has been timed out.',
    ban: 'The reported member has been banned.',
  }[action];
  return createEmbed({
    title: 'Success',
    description,
    color: 'success',
    fields: [{ name: 'Report', value: `report-${record.number}` }],
  });
}

export async function handleReportAction(interaction, client, [action, userId]) {
  if (!interaction.inGuild() || !['delete', 'timeout', 'ban'].includes(action)) return;
  if (interaction.message?.author?.id !== client.user.id) return;
  if (action === 'ban' && !reportActionAllowed(interaction, action)) {
    return deny(interaction, 'Only members with the Owner role can ban members from reports.');
  }
  // Show the modal before any database work. Submission revalidates staff access.
  const modal = new ModalBuilder().setCustomId(`report_moderate:${action}:${userId}:${interaction.message.id}`)
    .setTitle({ ban: 'Ban reported member', timeout: 'Timeout reported member', delete: 'Delete reported message' }[action]);
  if (action === 'timeout') modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('minutes').setLabel('Duration in minutes').setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(5),
  ));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph)
      .setRequired(true).setMaxLength(512),
  ));
  await interaction.showModal(modal);
}

export async function handleReportModeration(interaction, client, [action, userId, messageId]) {
  if (!interaction.inGuild() || !['delete', 'timeout', 'ban'].includes(action)) return;
  if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) return;
  const config = await getGuildConfig(client, interaction.guildId);
  if (!reportActionAllowed(interaction, action, config)) {
    return deny(interaction, action === 'ban' ? 'Only members with the Owner role can ban members from reports.' : 'Only the staff team can manage reports.');
  }
  const report = await interaction.channel.messages.fetch(messageId).catch(() => null);
  const ids = report?.components?.flatMap(row => row.components.map(button => button.customId)) || [];
  if (report?.author?.id !== client.user.id || !ids.includes(`report_action:${action}:${userId}`)) {
    return deny(interaction, 'This report is no longer available.');
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return deny(interaction, 'Please provide a reason.');
  if (action !== 'delete' && [interaction.user.id, client.user.id, interaction.guild.ownerId].includes(userId)) {
    return deny(interaction, 'You cannot moderate yourself, Cloudy, or the server owner.');
  }
  const completed = await completeReportAction(interaction, client, report, action, userId, reason);
  await interaction.channel.send({
    embeds: [reportSuccessEmbed(action, completed)],
    allowedMentions: { parse: [] },
  });
  await interaction.deleteReply().catch(() => {});
}

async function completeReportAction(interaction, client, report, action, userId, reason) {
  return withReportLock(reportKey(interaction.guildId, report.id), async () => {
    const record = await loadReport(client, interaction.guild, report, userId);
    if (record.closedAt || (record.expiresAt && record.expiresAt <= Date.now())) throw new Error('This report case has already closed.');
    const previous = record.actions?.[action];
    const completedAction = Object.entries(record.actions || {}).find(([name, outcome]) =>
      name !== action && (outcome?.status === 'completed' || outcome?.notified));
    if (completedAction) {
      if (report.components?.length) await report.edit({ components: [] });
      throw new Error('This report has already been handled.');
    }
    if (previous?.notified) {
      if (report.components?.length) await report.edit({ components: [] });
      throw new Error('This report action has already been completed.');
    }
    if (previous?.status === 'processing') throw new Error('This action is being processed. Staff must verify its outcome before retrying.');
    if (previous?.status !== 'completed') {
      // Validate the destination before performing a destructive moderation action.
      await validateReportDestinations(interaction.guild);
      const reportsChannel = report.channel || await interaction.guild.channels.fetch(record.reportChannelId);
      if (reportsChannel.permissionsFor?.(interaction.guild.roles.everyone)?.has?.(PermissionFlagsBits.ViewChannel)) throw new Error('Staff report controls require a private reports channel.');
      const durationMs = action === 'timeout' ? timeoutDuration(interaction.fields.getTextInputValue('minutes')) : null;
      let original;
      if (action === 'delete') {
        if (!record.sourceChannelId || !record.sourceMessageId) throw new Error('This report has no original message linked to Delete.');
        const source = await interaction.guild.channels.fetch(record.sourceChannelId);
        original = await source.messages.fetch(record.sourceMessageId);
      }
      const config = await getGuildConfig(client, interaction.guildId);
      const freshMember = await interaction.guild.members.fetch(interaction.user.id);
      if (!reportActionAllowed({ guild: interaction.guild, user: interaction.user, member: freshMember }, action, config)) {
        throw new Error(action === 'ban'
          ? 'Only members with the Owner role can ban members from reports.'
          : 'Only authorized staff can perform this action.');
      }
      if (!reason) throw new Error('Please provide a reason.');
      const pending = { status: 'processing', actorId: interaction.user.id, reason, durationMs };
      record.actions = { ...record.actions, [action]: pending };
      if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) throw new Error('The report action could not be saved.');
      try {
        if (action === 'delete') {
          rememberMessageDeleter(original, interaction.user);
          await original.delete();
        } else {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (action === 'timeout') {
            if (!member) throw new Error('The reported member is no longer in this server.');
            await ModerationService.timeoutUser({ guild: interaction.guild, member, moderator: freshMember,
              durationMs, reason });
          } else {
            const user = member?.user || await client.users.fetch(userId);
            await ModerationService.banUser({
              guild: interaction.guild,
              user,
              moderator: freshMember,
              reason,
              notifyBeforeBan: true,
              notificationPayload: reportBanNotification(reason),
            });
          }
        }
      } catch (error) {
        record.actions[action] = { ...pending, status: 'failed' };
        await client.db.set(reportKey(record.guildId, record.messageId), record);
        throw error;
      }
      record.actions[action] = { ...pending, status: 'completed' };
      if (await client.db.set(reportKey(record.guildId, record.messageId), record) === false) throw new Error('The action completed but saving it failed. Do not repeat the action.');
    }
    if (report.components?.length) await report.edit({ components: [] });
    const outcome = record.actions[action];
    const notified = await publishReportOutcome(client, interaction.guild, report, record, action, outcome.actorId, outcome.reason);
    notified.actions[action] = { ...outcome, notified: true };
    if (await client.db.set(reportKey(record.guildId, record.messageId), notified) === false) throw new Error('The action notification could not be saved.');
    return notified;
  });
}
