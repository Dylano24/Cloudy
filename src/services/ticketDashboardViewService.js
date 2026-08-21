import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { buildTicketDashboardPayload as buildBaseTicketDashboardPayload } from './ticketDashboardService.js';

function settingButton(guildId, setting, label, emoji) {
  return new ButtonBuilder()
    .setCustomId(`ticket_dashboard_open:${guildId}:${setting}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(emoji);
}

function textButton(guildId, setting, label, emoji) {
  return new ButtonBuilder()
    .setCustomId(`ticket_dashboard_text:${guildId}:${setting}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(emoji);
}

export function buildTicketDashboardPayload(guild, config = {}) {
  const payload = buildBaseTicketDashboardPayload(guild, config);

  // A direct button dashboard is deliberately used instead of a master select
  // menu. Every setting has one deterministic custom ID/handler, so there is no
  // extra selector state that can expire or route to the wrong function.
  payload.components = [
    new ActionRowBuilder().addComponents(
      settingButton(guild.id, 'panel_channel', 'Panel Channel', '💬'),
      settingButton(guild.id, 'open_category', 'Open Category', '📁'),
      settingButton(guild.id, 'closed_category', 'Closed Category', '📂'),
      settingButton(guild.id, 'staff_role', 'Staff Role', '🛡️'),
      settingButton(guild.id, 'max_tickets', 'Max Tickets', '🔢'),
    ),
    new ActionRowBuilder().addComponents(
      settingButton(guild.id, 'logs_channel', 'Logs Channel', '🎫'),
      settingButton(guild.id, 'transcript_channel', 'Transcript', '📜'),
      textButton(guild.id, 'panel_message', 'Panel Message', '📝'),
      textButton(guild.id, 'button_label', 'Button Label', '🏷️'),
      new ButtonBuilder()
        .setCustomId(`ticket_dashboard_repost:${guild.id}`)
        .setLabel('Repost Panel')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_dashboard_delete:${guild.id}`)
        .setLabel('Delete System')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),
    ),
  ];

  return payload;
}
