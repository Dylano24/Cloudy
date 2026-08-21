import { buildTicketDashboardPayload as buildBaseTicketDashboardPayload } from './ticketDashboardService.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';

export function brandTicketDashboardPayload(payload = {}) {
  if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
    payload.embeds = payload.embeds.map(embed => forceCloudyTicketFooter(embed));
  }
  return payload;
}

export function buildTicketDashboardPayload(guild, config = {}) {
  return brandTicketDashboardPayload(buildBaseTicketDashboardPayload(guild, config));
}
