import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, GAME_FEED_CHANNELS, gameFeedChannels,
} from '../../services/gameFeedService.js';
import { GAME_FEED_PATH } from '../../web/gameFeedApi.js';
import { BOARD_CHANNELS, POPULATION_WEBHOOK_NAME } from '../../services/gameServerBoardsService.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../../services/cloudyChannelResolver.js';

// Staff only: check the feed channels and what is still missing to link
// the game server.
export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('gamefeed')
    .setDescription('Game server feeds: check the channels and the link.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Check the feed channels and the game server link.')),

  async execute(interaction) {
    const channels = await gameFeedChannels(interaction.client);
    const linked = String(process.env.CLOUDY_GAME_FEED_SECRET || '').length >= 32;
    const lines = Object.entries(GAME_FEED_CHANNELS).map(([type, channel]) =>
      `**${channel.name}:** ${channels[type] ? `<#${channels[type].id}>` : 'Not found'}`);
    for (const [name, channel] of Object.entries(BOARD_CHANNELS)) {
      const found = interaction.guild && findCloudyChannelByAlias(interaction.guild,
        getCloudyChannelDefinition(channel.key)?.aliases || [], { textOnly: true });
      lines.push(`**${channel.name}:** ${found ? `<#${found.id}>` : 'Not found'}${name === 'population' ? ` (webhook ${POPULATION_WEBHOOK_NAME})` : ''}`);
    }
    return interaction.reply({
      embeds: [{
        title: 'Game server feeds',
        description: [
          ...lines,
          '',
          `**Game server link:** ${linked ? 'Ready' : 'Not linked yet'}`,
          `**Link point:** \`POST ${GAME_FEED_PATH}\``,
        ].join('\n'),
        color: 0xFFFFFF,
        thumbnail: { url: CLOUDY_C_LOGO_URL },
        footer: { text: CLOUDY_FOOTER },
      }],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
