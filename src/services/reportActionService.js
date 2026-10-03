import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { createEmbed } from '../utils/embeds.js';

export function buildReportActions(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_action:delete:${userId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`report_action:timeout:${userId}`).setLabel('Timeout').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report_action:ban:${userId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
  )];
}

export function reportActionAllowed(interaction, action, config = {}) {
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  if (action === 'ban') return isOwner;
  const staffId = config.ticketStaffRoleId || interaction.guild.roles?.cache?.find(
    role => role.name.trim().toLowerCase() === 'staff',
  )?.id;
  const permission = action === 'timeout' ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.ManageMessages;
  return isOwner || Boolean(interaction.member?.permissions?.has?.(permission))
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

export async function handleReportAction(interaction, client, [action, userId]) {
  if (!interaction.inGuild() || !['delete', 'timeout', 'ban'].includes(action)) return;
  if (interaction.message?.author?.id !== client.user.id) return;
  const config = await getGuildConfig(client, interaction.guildId);
  if (!reportActionAllowed(interaction, action, config)) {
    return deny(interaction, action === 'ban' ? 'Only the server owner can ban members from reports.' : 'Only the staff team can manage reports.');
  }
  if (action === 'delete') {
    await interaction.deferUpdate();
    await interaction.message.delete();
    return;
  }
  const modal = new ModalBuilder().setCustomId(`report_moderate:${action}:${userId}:${interaction.message.id}`)
    .setTitle(action === 'ban' ? 'Ban reported member' : 'Timeout reported member');
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
  if (!interaction.inGuild() || !['timeout', 'ban'].includes(action)) return;
  if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) return;
  const config = await getGuildConfig(client, interaction.guildId);
  if (!reportActionAllowed(interaction, action, config)) {
    return deny(interaction, action === 'ban' ? 'Only the server owner can ban members from reports.' : 'Only the staff team can manage reports.');
  }
  const report = await interaction.channel.messages.fetch(messageId).catch(() => null);
  const ids = report?.components?.flatMap(row => row.components.map(button => button.customId)) || [];
  if (report?.author?.id !== client.user.id || !ids.includes(`report_action:${action}:${userId}`)) {
    return deny(interaction, 'This report is no longer available.');
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return deny(interaction, 'Please provide a reason.');
  if ([interaction.user.id, client.user.id, interaction.guild.ownerId].includes(userId)) {
    return deny(interaction, 'You cannot moderate yourself, Cloudy, or the server owner.');
  }
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (action === 'timeout') {
    const durationMs = timeoutDuration(interaction.fields.getTextInputValue('minutes'));
    if (!member) return deny(interaction, 'The reported member is no longer in this server.');
    await ModerationService.timeoutUser({ guild: interaction.guild, member, moderator: interaction.member, durationMs, reason });
  } else {
    const user = member?.user || await client.users.fetch(userId);
    await ModerationService.banUser({ guild: interaction.guild, user, moderator: interaction.member, reason });
  }
  await InteractionHelper.safeEditReply(interaction, {
    embeds: [createEmbed({ title: 'Success', description: action === 'ban' ? 'The reported member has been banned.' : 'The reported member has been timed out.' })],
  });
}
