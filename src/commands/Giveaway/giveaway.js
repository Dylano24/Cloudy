import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { botConfig } from '../../config/bot.js';
import createCommand from './gcreate.js';
import deleteCommand from './gdelete.js';
import endCommand from './gend.js';
import rerollCommand from './greroll.js';

const GIVEAWAY_MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const GIVEAWAY_MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

export default {
  category: 'Giveaway',
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create, end, reroll or delete giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Start a new giveaway')
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('Duration, e.g. 30m, 1h or 5d')
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('winners')
            .setDescription('Number of winners')
            .setMinValue(GIVEAWAY_MIN_WINNERS)
            .setMaxValue(GIVEAWAY_MAX_WINNERS)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('prize')
            .setDescription('Prize being given away')
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Destination channel; defaults to the current channel')
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('End an active giveaway immediately')
        .addStringOption((option) =>
          option.setName('messageid').setDescription('Giveaway message ID').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Reroll winner(s) for an ended giveaway')
        .addStringOption((option) =>
          option.setName('messageid').setDescription('Giveaway message ID').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a giveaway message and database entry')
        .addStringOption((option) =>
          option.setName('messageid').setDescription('Giveaway message ID').setRequired(true),
        ),
    ),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'create':
        return createCommand.execute(interaction, config, client);
      case 'end':
        return endCommand.execute(interaction, config, client);
      case 'reroll':
        return rerollCommand.execute(interaction, config, client);
      case 'delete':
        return deleteCommand.execute(interaction, config, client);
      default:
        throw new Error(`Unknown giveaway subcommand: ${subcommand}`);
    }
  },
};
