import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from '../../services/gameFeedService.js';
import { readAdvancedRustLeaderboard } from '../../services/advancedRustLeaderboardService.js';
import { logger } from '../../utils/logger.js';

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('ruststats')
    .setDescription('View Rust kills, deaths and K/D.')
    .setDMPermission(false)
    .addStringOption(option => option.setName('server')
      .setDescription('Optional Rust server name.').setMaxLength(60).setRequired(false))
    .addBooleanOption(option => option.setName('public')
      .setDescription('Post publicly (staff only).').setRequired(false)),

  async execute(interaction) {
    const publicRequested = interaction.options.getBoolean('public') === true;
    const allowedPublic = publicRequested && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    await interaction.deferReply(allowedPublic ? {} : { flags: MessageFlags.Ephemeral });
    try {
      const embeds = await readAdvancedRustLeaderboard(
        interaction.client, interaction.guildId, interaction.options.getString('server'));
      await interaction.editReply({ embeds, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.warn('[RUST_STATS] Could not load leaderboard:', error);
      await interaction.editReply({
        embeds: [{
          title: 'Something went wrong', description: 'Could not load Rust statistics.',
          color: 0x7A1712, thumbnail: { url: CLOUDY_C_LOGO_URL },
          footer: { text: CLOUDY_FOOTER },
        }],
      });
    }
  },
};
