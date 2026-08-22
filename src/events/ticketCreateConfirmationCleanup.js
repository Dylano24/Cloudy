import { Events } from 'discord.js';

const TICKET_CREATED_REPLY_TTL_MS = 2 * 60 * 1000;

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    // Only target the ephemeral "Ticket Created" reply from the ticket modal.
    // This never touches the created ticket channel or its messages.
    if (interaction?.customId !== 'create_ticket_modal') return;

    const timer = setTimeout(async () => {
      try {
        // Prefer Discord.js' interaction helper for the original ephemeral reply.
        await interaction.deleteReply();
      } catch {
        // Fallback to deleting only the original interaction response.
        await interaction.webhook?.deleteMessage?.('@original').catch(() => {});
      }
    }, TICKET_CREATED_REPLY_TTL_MS);

    timer.unref?.();
  },
};
