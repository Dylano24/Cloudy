import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  getRandomMotivation,
  parseReminderDuration,
  createMotivationReminder,
  getUserMotivationReminders,
  cancelMotivationReminder,
} from '../../services/motivationService.js';
import motivationConfigCommand from './motivation-config.js';

function quoteEmbed(text, title = '💡 Motivation') {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(text)
    .setTimestamp();
}

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('motivation')
    .setDescription('Motivational quotes, reminders and daily motivation settings')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub.setName('quote').setDescription('Get a motivational quote'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('send')
        .setDescription('Send a motivational quote to a friend by DM')
        .addUserOption((option) =>
          option.setName('user').setDescription('Friend to motivate').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remind')
        .setDescription('Create a motivation reminder')
        .addStringOption((option) =>
          option
            .setName('in')
            .setDescription('When: e.g. 10m, 2h, 3d or 1w')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('Optional reminder text; otherwise Cloudy sends a motivation quote')
            .setMaxLength(500),
        )
        .addStringOption((option) =>
          option
            .setName('repeat')
            .setDescription('Optional repeat interval: e.g. 1d or 1w'),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Optional recipient; defaults to you'),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('reminders').setDescription('List your active motivation reminders'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel one of your motivation reminders')
        .addStringOption((option) =>
          option.setName('id').setDescription('Reminder ID from /motivation reminders').setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('config')
        .setDescription('Administrator settings for automatic motivation')
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
    ),

  async execute(interaction, config, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (group === 'config') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return InteractionHelper.safeReply(interaction, {
          content: 'You need **Administrator** permission to change motivation server settings.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return motivationConfigCommand.execute(interaction, config, client);
    }

    if (subcommand === 'quote') {
      return InteractionHelper.safeReply(interaction, {
        embeds: [quoteEmbed(getRandomMotivation())],
      });
    }

    if (subcommand === 'send') {
      const user = interaction.options.getUser('user', true);
      const quote = getRandomMotivation();

      try {
        await user.send({
          content: `${interaction.user.tag} sent you some motivation:`,
          embeds: [quoteEmbed(quote)],
        });

        return InteractionHelper.safeReply(interaction, {
          content: `✅ Sent a motivational quote to ${user}.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        return InteractionHelper.safeReply(interaction, {
          content: `I couldn't DM ${user}. They may have DMs disabled.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === 'remind') {
      const durationInput = interaction.options.getString('in', true);
      const durationMs = parseReminderDuration(durationInput);
      if (!durationMs) {
        return InteractionHelper.safeReply(interaction, {
          content: 'Use a duration like `10m`, `2h`, `3d` or `1w` (maximum 365 days).',
          flags: MessageFlags.Ephemeral,
        });
      }

      const repeatInput = interaction.options.getString('repeat');
      const repeatMs = repeatInput ? parseReminderDuration(repeatInput) : null;
      if (repeatInput && !repeatMs) {
        return InteractionHelper.safeReply(interaction, {
          content: 'The repeat interval must look like `1h`, `1d` or `1w`.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const target = interaction.options.getUser('user') || interaction.user;
      const isOtherUser = target.id !== interaction.user.id;
      if (
        isOtherUser
        && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        return InteractionHelper.safeReply(interaction, {
          content: 'You need **Manage Server** to create reminders for another member.',
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        const reminder = await createMotivationReminder(client, {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          targetUserId: target.id,
          durationMs,
          repeatMs,
          message: interaction.options.getString('message'),
        });

        return InteractionHelper.safeReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('⏰ Motivation Reminder Created')
              .setDescription(
                `**ID:** \`${reminder.id}\`\n` +
                `**For:** ${target}\n` +
                `**Runs:** <t:${Math.floor(reminder.runAt / 1000)}:R>` +
                (repeatMs ? `\n**Repeats:** every ${repeatInput}` : '')
              )
              .setTimestamp(),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        return InteractionHelper.safeReply(interaction, {
          content: error?.message || 'Could not create that reminder.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === 'reminders') {
      const reminders = await getUserMotivationReminders(client, interaction.guildId, interaction.user.id);
      if (!reminders.length) {
        return InteractionHelper.safeReply(interaction, {
          content: 'You have no active motivation reminders.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = reminders.slice(0, 25).map((reminder) =>
        `• \`${reminder.id}\` → <@${reminder.targetUserId}> • <t:${Math.floor(reminder.runAt / 1000)}:R>${reminder.repeatMs ? ' • repeating' : ''}`
      );

      return InteractionHelper.safeReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Your Motivation Reminders')
            .setDescription(lines.join('\n')),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'cancel') {
      const id = interaction.options.getString('id', true);
      const removed = await cancelMotivationReminder(
        client,
        interaction.guildId,
        interaction.user.id,
        id,
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
      );

      return InteractionHelper.safeReply(interaction, {
        content: removed ? `✅ Reminder \`${id.toUpperCase()}\` cancelled.` : 'Reminder not found.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
