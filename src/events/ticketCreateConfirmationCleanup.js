import { Events } from 'discord.js';

const TICKET_CREATED_REPLY_TTL_MS = 2 * 60 * 1000;

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    if (interaction?.customId !== 'create_ticket_modal') return;

    const timer = setTimeout(async () => {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply().catch(() => {});
        }
      } catch {
        // Reply may already have been dismissed/deleted.
      }
    }, TICKET_CREATED_REPLY_TTL_MS);

    timer.unref?.();
  },
};
