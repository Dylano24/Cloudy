import { buildTicketDashboardPayload as buildBaseTicketDashboardPayload } from './ticketDashboardService.js';
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
  return brandTicketDashboardPayload(buildBaseTicketDashboardPayload(guild, config));
}
