import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  addYouTubeSubscription,
  removeYouTubeSubscription,
  getYouTubeSubscriptions,
  testYouTubeSubscription,
} from '../../services/youtubeService.js';

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('youtube-alerts')
    .setDescription('Configure YouTube upload notifications')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Subscribe this server to a YouTube channel')
        .addStringOption((option) =>
          option
            .setName('youtube_channel')
            .setDescription('YouTube channel ID, @handle or URL')
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName('discord_channel')
            .setDescription('Discord channel for upload notifications')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addRoleOption((option) =>
          option
            .setName('mention_role')
            .setDescription('Optional role to mention on new uploads'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a YouTube upload subscription')
        .addStringOption((option) =>
          option
            .setName('youtube_channel')
            .setDescription('Channel ID, @handle or exact stored channel title')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List configured YouTube upload subscriptions'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Send a test notification using the latest upload')
        .addStringOption((option) =>
          option
            .setName('youtube_channel')
            .setDescription('Channel ID or exact stored channel title')
            .setRequired(true),
        ),
    ),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    try {
      if (subcommand === 'add') {
        const youtubeChannel = interaction.options.getString('youtube_channel', true);
        const discordChannel = interaction.options.getChannel('discord_channel', true);
        const mentionRole = interaction.options.getRole('mention_role');

        const subscription = await addYouTubeSubscription(client, {
          guildId: interaction.guildId,
          youtubeChannel,
          discordChannelId: discordChannel.id,
          mentionRoleId: mentionRole?.id || null,
        });

        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📺 YouTube Alert Added')
              .setDescription(
                `**YouTube:** ${subscription.youtubeChannelTitle}\n` +
                `**Channel ID:** \`${subscription.youtubeChannelId}\`\n` +
                `**Discord:** ${discordChannel}\n` +
                `**Mention:** ${mentionRole || 'None'}\n\n` +
                'Cloudy checks for new uploads automatically.'
              ),
          ],
        });
      }

      if (subcommand === 'remove') {
        const identifier = interaction.options.getString('youtube_channel', true);
        const removed = await removeYouTubeSubscription(client, interaction.guildId, identifier);

        return InteractionHelper.safeEditReply(interaction, {
          content: removed
            ? '✅ YouTube upload subscription removed.'
            : 'No matching YouTube subscription was found.',
          embeds: [],
        });
      }

      const subscriptions = await getYouTubeSubscriptions(client, interaction.guildId);

      if (subcommand === 'list') {
        if (!subscriptions.length) {
          return InteractionHelper.safeEditReply(interaction, {
            content: 'No YouTube upload subscriptions are configured.',
          });
        }

        const lines = subscriptions.map((entry, index) =>
          `**${index + 1}. ${entry.youtubeChannelTitle || 'YouTube Channel'}**\n` +
          `\`${entry.youtubeChannelId}\` → <#${entry.discordChannelId}>` +
          (entry.mentionRoleId ? ` • <@&${entry.mentionRoleId}>` : '')
        );

        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📺 YouTube Upload Subscriptions')
              .setDescription(lines.join('\n\n').slice(0, 4000)),
          ],
        });
      }

      if (subcommand === 'test') {
        const identifier = interaction.options.getString('youtube_channel', true).trim().toLowerCase();
        const subscription = subscriptions.find((entry) =>
          entry.youtubeChannelId.toLowerCase() === identifier ||
          String(entry.youtubeChannelTitle || '').toLowerCase() === identifier
        );

        if (!subscription) {
          return InteractionHelper.safeEditReply(interaction, {
            content: 'That subscription is not configured. Use `/youtube-alerts list` first.',
          });
        }

        await testYouTubeSubscription(client, interaction.guild, subscription);
        return InteractionHelper.safeEditReply(interaction, {
          content: '✅ Test upload notification sent.',
        });
      }
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `❌ ${error?.message || 'YouTube alert configuration failed.'}`,
        embeds: [],
        components: [],
      });
    }
  },
};
