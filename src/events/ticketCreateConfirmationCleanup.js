import { Events } from 'discord.js';

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    // Ticket-created replies are lifecycle-managed by
    // ticketCreationConfirmationService and are not removed by a timer.
    if (interaction?.customId !== 'create_ticket_modal') return;
  },
};
