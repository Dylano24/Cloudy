import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { syncWipePrize } from '../../services/wipeAutomationService.js';

const messages = Object.freeze({
  synced: 'Your wipe giveaway winner role has been assigned.',
  already: 'Your wipe giveaway winner role is already synced.',
  'not-winner': 'You have no kit giveaway prize to sync.',
  'role-unavailable': 'The winner role is currently unavailable. Please contact staff.',
  unavailable: 'Wipe giveaway sync is not available in this server.',
});

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('wipe')
    .setDescription('Manage your automatic Rust wipe giveaway prize.')
    .addSubcommand(sub => sub.setName('sync')
      .setDescription('Sync your temporary Discord winner role for this wipe.')),
  async execute(interaction) {
    if (interaction.options.getSubcommand() !== 'sync') return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await syncWipePrize(interaction.client, interaction.member);
      await interaction.editReply({ content: messages[result.status] || 'Wipe prize sync failed.' });
    } catch {
      await interaction.editReply({ content: 'Wipe prize sync failed. Please try again.' });
    }
  },
};
