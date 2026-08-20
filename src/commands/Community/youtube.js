import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  getLatestYouTubeVideo,
  getYouTubeVideoInfo,
  getYouTubeChannelInfo,
  getYouTubePlaylistInfo,
  getYouTubeTrending,
  getRandomYouTubeVideo,
} from '../../services/youtubeService.js';

function number(value) {
  if (value == null) return 'Unknown';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString('en-US') : String(value);
}

function errorReply(interaction, error) {
  return InteractionHelper.safeReply(interaction, {
    content: `❌ ${error?.message || 'YouTube request failed.'}`,
    flags: MessageFlags.Ephemeral,
  });
}

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('YouTube video, channel, playlist and discovery tools')
    .addSubcommand((sub) =>
      sub
        .setName('latest')
        .setDescription('Show the latest upload from a YouTube channel')
        .addStringOption((option) =>
          option.setName('channel').setDescription('Channel ID, @handle or URL').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('video')
        .setDescription('Show information about a YouTube video')
        .addStringOption((option) =>
          option.setName('video').setDescription('YouTube video URL or ID').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Show information about a YouTube channel')
        .addStringOption((option) =>
          option.setName('channel').setDescription('Channel ID, @handle or URL').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('playlist')
        .setDescription('Show information about a public YouTube playlist')
        .addStringOption((option) =>
          option.setName('playlist').setDescription('Playlist URL or ID').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('trending')
        .setDescription('Show popular YouTube videos for a country')
        .addStringOption((option) =>
          option.setName('country').setDescription('Two-letter country code, e.g. NL, FR, US').setMaxLength(2),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('random')
        .setDescription('Get a random YouTube video for a search query')
        .addStringOption((option) =>
          option.setName('query').setDescription('What to search for').setRequired(true).setMaxLength(100),
        ),
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    await InteractionHelper.safeDefer(interaction);

    try {
      if (subcommand === 'latest') {
        const result = await getLatestYouTubeVideo(interaction.options.getString('channel', true));
        if (!result.video) throw new Error('No public videos were found for that channel.');

        const embed = new EmbedBuilder()
          .setTitle(result.video.title)
          .setURL(result.video.url)
          .setAuthor({ name: result.channel.title })
          .setThumbnail(result.video.thumbnail)
          .setDescription(result.video.description?.slice(0, 1000) || 'Latest YouTube upload')
          .setTimestamp(result.video.published ? new Date(result.video.published) : new Date());

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      if (subcommand === 'video') {
        const video = await getYouTubeVideoInfo(interaction.options.getString('video', true));
        const embed = new EmbedBuilder()
          .setTitle(video.title)
          .setURL(video.url)
          .setAuthor({ name: video.author })
          .setThumbnail(video.thumbnail)
          .addFields({ name: 'Video ID', value: `\`${video.id}\``, inline: true });
        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      if (subcommand === 'channel') {
        const channel = await getYouTubeChannelInfo(interaction.options.getString('channel', true));
        const embed = new EmbedBuilder()
          .setTitle(channel.title)
          .setURL(channel.url)
          .setDescription(channel.description?.slice(0, 1500) || 'YouTube channel')
          .setThumbnail(channel.thumbnail || channel.latestVideo?.thumbnail || null)
          .addFields(
            { name: 'Channel ID', value: `\`${channel.id}\``, inline: false },
            { name: 'Subscribers', value: number(channel.statistics?.subscriberCount), inline: true },
            { name: 'Views', value: number(channel.statistics?.viewCount), inline: true },
            { name: 'Videos', value: number(channel.statistics?.videoCount), inline: true },
          );

        if (channel.latestVideo) {
          embed.addFields({
            name: 'Latest Upload',
            value: `[${channel.latestVideo.title}](${channel.latestVideo.url})`,
            inline: false,
          });
        }

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      if (subcommand === 'playlist') {
        const playlist = await getYouTubePlaylistInfo(interaction.options.getString('playlist', true));
        const embed = new EmbedBuilder()
          .setTitle(playlist.title)
          .setURL(playlist.url)
          .setDescription(playlist.description?.slice(0, 1500) || 'YouTube playlist')
          .setThumbnail(playlist.thumbnail)
          .addFields(
            { name: 'Creator', value: playlist.creator, inline: true },
            { name: 'Videos', value: number(playlist.itemCount), inline: true },
          );
        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      if (subcommand === 'trending') {
        const country = (interaction.options.getString('country') || 'US').toUpperCase();
        const videos = await getYouTubeTrending(country);
        if (!videos.length) throw new Error('No trending videos were returned.');

        const lines = videos.map((video, index) =>
          `**${index + 1}.** [${video.title}](${video.url}) — ${video.channelTitle}${video.views ? ` • ${number(video.views)} views` : ''}`
        );

        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`🔥 YouTube Trending — ${country}`)
              .setDescription(lines.join('\n').slice(0, 4000)),
          ],
        });
      }

      if (subcommand === 'random') {
        const video = await getRandomYouTubeVideo(interaction.options.getString('query', true));
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle(video.title)
              .setURL(video.url)
              .setAuthor({ name: video.channelTitle })
              .setThumbnail(video.thumbnail),
          ],
        });
      }
    } catch (error) {
      if (interaction.deferred || interaction.replied) {
        return InteractionHelper.safeEditReply(interaction, {
          content: `❌ ${error?.message || 'YouTube request failed.'}`,
          embeds: [],
          components: [],
        });
      }
      return errorReply(interaction, error);
    }
  },
};
