import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../../utils/embeds.js';
import { buildGamesCommandListText } from '../../config/gamblingCommands.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder().setName('games').setDescription('Casino game information')
    .addSubcommand(subcommand => subcommand.setName('info').setDescription('Show all available casino games')),
  category: 'Economy',
  async execute(interaction) {
    await InteractionHelper.safeReply(interaction, { embeds: [infoEmbed('Games', buildGamesCommandListText())], components: [] });
  },
};
