import { Events } from 'discord.js';
import { renderTicketV2 } from '../services/ticketV2LayoutService.js';

const TICKET_INTERACTIONS = new Set([
  'ticket_claim',
  'ticket_unclaim',
  'ticket_pin',
  'ticket_priority_menu',
  'ticket_priority_select',
  'ticket_close_modal',
  'ticket_reopen',
]);

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction?.guild || !interaction?.channel) return;
    if (!TICKET_INTERACTIONS.has(interaction.customId)) return;

    const timer = setTimeout(() => {
      renderTicketV2(interaction.channel).catch(() => {});
    }, 700);
    timer.unref?.();
  },
};
