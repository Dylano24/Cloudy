import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  configureDailyMotivation,
  getDailyMotivationConfig,
} from '../../services/motivationService.js';

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('motivation-config')
    .setDescription('Configure automatic motivation messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('daily')
        .setDescription('Configure a daily motivation message')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Enable or disable daily motivation').setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel for daily motivation')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addIntegerOption((option) =>
          option
            .setName('hour_utc')
            .setDescription('UTC hour (0-23) to send the message')
            .setMinValue(0)
            .setMaxValue(23),
        )
        .addRoleOption((option) =>
          option.setName('mention_role').setDescription('Optional role to mention'),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show current daily motivation settings'),
    ),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'status') {
      const current = await getDailyMotivationConfig(client, interaction.guildId);
      if (!current) {
        return InteractionHelper.safeReply(interaction, {
          content: 'Daily motivation is not configured yet.',
          flags: MessageFlags.Ephemeral,
        });
      }

      return InteractionHelper.safeReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle('🌤️ Daily Motivation Settings')
            .addFields(
              { name: 'Enabled', value: current.enabled ? 'Yes' : 'No', inline: true },
              { name: 'Channel', value: current.channelId ? `<#${current.channelId}>` : 'Not set', inline: true },
              { name: 'UTC Hour', value: String(current.hourUtc ?? 9), inline: true },
              { name: 'Mention Role', value: current.mentionRoleId ? `<@&${current.mentionRoleId}>` : 'None', inline: true },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const previous = await getDailyMotivationConfig(client, interaction.guildId) || {};
    const enabled = interaction.options.getBoolean('enabled', true);
    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('mention_role');
    const hour = interaction.options.getInteger('hour_utc');

    if (enabled && !channel && !previous.channelId) {
      return InteractionHelper.safeReply(interaction, {
        content: 'Choose a channel when enabling daily motivation for the first time.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const saved = await configureDailyMotivation(client, interaction.guildId, {
      ...previous,
      enabled,
      channelId: channel?.id || previous.channelId || null,
      hourUtc: hour ?? previous.hourUtc ?? 9,
      mentionRoleId: role?.id ?? previous.mentionRoleId ?? null,
    });

    return InteractionHelper.safeReply(interaction, {
      content: saved.enabled
        ? `✅ Daily motivation will post in <#${saved.channelId}> at **${saved.hourUtc}:00 UTC**.`
        : '✅ Daily motivation disabled.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
