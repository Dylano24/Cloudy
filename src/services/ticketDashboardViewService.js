import { ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildTicketDashboardPayload as buildBaseTicketDashboardPayload } from './ticketDashboardService.js';

export function buildTicketDashboardPayload(guild, config = {}) {
  const payload = buildBaseTicketDashboardPayload(guild, config);
  const firstRow = payload?.components?.[0];

  if (firstRow?.components?.length < 5) {
    firstRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_dashboard_max:${guild.id}`)
        .setLabel('Max Tickets')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔢'),
    );
  }

  return payload;
}
