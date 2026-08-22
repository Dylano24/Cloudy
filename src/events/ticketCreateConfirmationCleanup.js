import { Events } from 'discord.js';

const TICKET_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction?.customId !== 'create_ticket_modal') return;

    const timer = setTimeout(async () => {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply().catch(() => {});
        }
      } catch {
        // The confirmation may already be gone; nothing else to do.
      }
    }, TICKET_CONFIRMATION_TTL_MS);

    timer.unref?.();
  },
};
