import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, GAME_FEED_CHANNELS, SAMPLE_GAME_FEED_EVENTS,
  buildGameFeedEmbed, gameFeedChannels, normalizeGameFeedEvent,
} from '../../services/gameFeedService.js';
import { GAME_FEED_PATH } from '../../web/gameFeedApi.js';
import {
  BOARD_CHANNELS, POPULATION_WEBHOOK_NAME, buildDailyTopKiller, buildLeaderboard, buildPopulationBoard, buildStatusBoard,
} from '../../services/gameServerBoardsService.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../../services/cloudyChannelResolver.js';

// Example boards for the preview: two servers, one offline.
function sampleBoards(now = Date.now()) {
  const state = {
    servers: {
      'Cloudy Rust': { online: true, players: 87, max: 100, queue: 3, map: 'Procedural 4000', nextWipe: now + 3 * 86_400_000, updatedAt: now },
      'Cloudy Rust 2': { online: false, updatedAt: now },
    },
    leaderboard: {
      'Cloudy Rust': { since: now - 2 * 86_400_000, players: { 'Dyn': { kills: 25, deaths: 4 }, 'Dylano': { kills: 19, deaths: 7 }, 'Cloudy': { kills: 6, deaths: 9 } } },
    },
    messages: {},
  };
  return [buildStatusBoard(state, now), buildPopulationBoard(state, now), buildLeaderboard(state, now),
    buildDailyTopKiller('Cloudy Rust', { 'Dyn': 25, 'Dylano': 19, 'Cloudy': 6 }, now)];
}

// Staff only: see the feed embeds before the game server is linked, and
// check what is still missing to link it.
export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('gamefeed')
    .setDescription('Game server feeds: show all embeds and check the link.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('embeds')
      .setDescription('Show example embeds of every game server feed and board.'))
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Check the feed channels and the game server link.')),

  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'embeds') {
      // The ban examples tag you, so the tag is visible in the preview.
      const you = interaction.user?.id;
      const embeds = SAMPLE_GAME_FEED_EVENTS
        .map(event => (event.type === 'ban' && you ? { ...event, discord: you, byDiscord: you } : event))
        .map(event => buildGameFeedEmbed({ ...normalizeGameFeedEvent(event), streak: event.streak, protectedFor: event.protectedFor }));
      await interaction.reply({ embeds, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      // The live boards (#server-status, #population, #leaderboard).
      return interaction.followUp({ embeds: sampleBoards(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
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
