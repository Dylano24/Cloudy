import { MessageFlags } from 'discord.js';

export default {
  name: 'dismiss-response',

  async execute(interaction, client, args = []) {
    const [ownerId] = args;

    if (ownerId && interaction.user.id !== ownerId) {
      await interaction.reply({
        content: 'Only the user who opened this panel can close it.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await interaction.deferUpdate().catch(() => {});

    const deleted = await interaction.message?.delete?.().then(() => true).catch(() => false);
    if (!deleted) {
      await interaction.editReply({ components: [] }).catch(() => {});
    }
  },
};
