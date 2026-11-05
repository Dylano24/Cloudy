import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, GAME_FEED_CHANNELS, SAMPLE_GAME_FEED_EVENTS,
  buildGameFeedEmbed, gameFeedChannels, normalizeGameFeedEvent,
} from '../../services/gameFeedService.js';
import { GAME_FEED_PATH } from '../../web/gameFeedApi.js';

// Staff only: see the feed embeds before the game server is linked, and
// check what is still missing to link it.
export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('gamefeed')
    .setDescription('Game server feeds: preview the embeds and check the link.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('preview')
      .setDescription('Show example embeds of every game server feed.'))
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Check the feed channels and the game server link.')),

  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'preview') {
      const embeds = SAMPLE_GAME_FEED_EVENTS.map(event => buildGameFeedEmbed(normalizeGameFeedEvent(event)));
      return interaction.reply({ embeds, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    const channels = await gameFeedChannels(interaction.client);
    const linked = String(process.env.CLOUDY_GAME_FEED_SECRET || '').length >= 32;
    const lines = Object.entries(GAME_FEED_CHANNELS).map(([type, channel]) =>
      `**${channel.name}:** ${channels[type] ? `<#${channels[type].id}>` : 'Not found'}`);
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
