import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../../utils/embeds.js';
import { buildGamblingCommandListText } from '../../config/gamblingCommands.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder().setName('gamble').setDescription('Gambling and economy information')
    .addSubcommand(subcommand => subcommand.setName('info').setDescription('Show all gambling and economy commands')),
  category: 'Economy',
  async execute(interaction) {
    await InteractionHelper.safeReply(interaction, { embeds: [infoEmbed('Gambling', buildGamblingCommandListText())], components: [] });
  },
};
