import { StringSelectMenuOptionBuilder } from 'discord.js';
import { buildTicketDashboardPayload as buildBaseTicketDashboardPayload } from './ticketDashboardService.js';
import { DEFAULT_TICKET_PANEL_TITLE } from './ticketPanelBuilder.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';

export function brandTicketDashboardPayload(payload = {}) {
  if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
    payload.embeds = payload.embeds.map(embed => {
      const branded = forceCloudyTicketFooter(embed);
      if (Array.isArray(branded.fields)) {
        branded.fields = branded.fields.filter(field => field?.name !== 'Panel Message');
      }
      return branded;
    });
  }
  return payload;
}

export function buildTicketDashboardPayload(guild, config = {}) {
  const payload = buildBaseTicketDashboardPayload(guild, config);

  const dashboardEmbed = payload.embeds?.[0];
  if (dashboardEmbed?.addFields) {
    dashboardEmbed.addFields({
      name: 'Panel Title',
      value: `\`${String(config.ticketPanelTitle || DEFAULT_TICKET_PANEL_TITLE).replace(/`/g, "'")}\``,
      inline: true,
    });
  }

  const dashboardSelect = payload.components?.[1]?.components?.[0];
  if (dashboardSelect?.addOptions) {
    dashboardSelect.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Change Panel Title')
        .setDescription('Change the title shown above the panel message')
        .setValue('panel_title')
        .setEmoji('✏️'),
    );
  }

  return brandTicketDashboardPayload(payload);
}
