import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  addPatchSubscription,
  removePatchSubscription,
  getPatchSubscriptions,
  testPatchSubscription,
} from '../../services/patchFeedService.js';

function addDestinationOptions(sub) {
  sub.addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('Discord channel for update notifications')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true),
  );
  sub.addRoleOption((option) =>
    option.setName('mention_role').setDescription('Optional role to mention'),
  );
  sub.addStringOption((option) =>
    option.setName('label').setDescription('Optional display label').setMaxLength(100),
  );
  return sub;
}

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('patch-config')
    .setDescription('Configure automatic patch/update notifications')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => {
      sub
        .setName('steam')
        .setDescription('Subscribe to Steam game news')
        .addStringOption((option) =>
          option.setName('app').setDescription('Steam App ID or store URL').setRequired(true),
        );
      return addDestinationOptions(sub);
    })
    .addSubcommand((sub) => {
      sub
        .setName('github')
        .setDescription('Subscribe to GitHub releases')
        .addStringOption((option) =>
          option.setName('repository').setDescription('Repository, e.g. owner/repo').setRequired(true),
        );
      return addDestinationOptions(sub);
    })
    .addSubcommand((sub) => {
      sub
        .setName('feed')
        .setDescription('Subscribe to a generic RSS/Atom update feed')
        .addStringOption((option) =>
          option.setName('url').setDescription('RSS/Atom feed URL').setRequired(true),
        );
      return addDestinationOptions(sub);
    })
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove an update subscription')
        .addStringOption((option) =>
          option.setName('id').setDescription('Subscription ID from /patch-config list').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List configured update subscriptions'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Send the latest item as a test notification')
        .addStringOption((option) =>
          option.setName('id').setDescription('Subscription ID').setRequired(true),
        ),
    ),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    try {
      if (['steam', 'github', 'feed'].includes(subcommand)) {
        const provider = subcommand === 'feed' ? 'rss' : subcommand;
        const source = subcommand === 'steam'
          ? interaction.options.getString('app', true)
          : subcommand === 'github'
            ? interaction.options.getString('repository', true)
            : interaction.options.getString('url', true);
        const channel = interaction.options.getChannel('channel', true);
        const role = interaction.options.getRole('mention_role');
        const label = interaction.options.getString('label');

        const subscription = await addPatchSubscription(client, {
          guildId: interaction.guildId,
          provider,
          source,
          discordChannelId: channel.id,
          mentionRoleId: role?.id || null,
          label,
        });

        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📰 Update Subscription Saved')
              .setDescription(
                `**ID:** \`${subscription.id}\`\n` +
                `**Source:** ${subscription.label}\n` +
                `**Provider:** ${subscription.provider.toUpperCase()}\n` +
                `**Discord:** ${channel}\n` +
                `**Mention:** ${role || 'None'}`
              ),
          ],
        });
      }

      if (subcommand === 'remove') {
        const id = interaction.options.getString('id', true);
        const removed = await removePatchSubscription(client, interaction.guildId, id);
        return InteractionHelper.safeEditReply(interaction, {
          content: removed ? `✅ Subscription \`${id.toUpperCase()}\` removed.` : 'Subscription not found.',
        });
      }

      const subscriptions = await getPatchSubscriptions(client, interaction.guildId);

      if (subcommand === 'list') {
        if (!subscriptions.length) {
          return InteractionHelper.safeEditReply(interaction, {
            content: 'No patch/update subscriptions are configured.',
          });
        }
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📰 Patch/Update Subscriptions')
              .setDescription(
                subscriptions.map((entry) =>
                  `• \`${entry.id}\` **${entry.label}** — ${entry.provider.toUpperCase()} → <#${entry.discordChannelId}>`
                ).join('\n').slice(0, 4000)
              ),
          ],
        });
      }

      if (subcommand === 'test') {
        const id = interaction.options.getString('id', true).toUpperCase();
        const subscription = subscriptions.find((entry) => String(entry.id).toUpperCase() === id);
        if (!subscription) {
          return InteractionHelper.safeEditReply(interaction, { content: 'Subscription not found.' });
        }
        await testPatchSubscription(client, interaction.guild, subscription);
        return InteractionHelper.safeEditReply(interaction, { content: '✅ Test update sent.' });
      }
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `❌ ${error?.message || 'Patch configuration failed.'}`,
        embeds: [],
      });
    }
  },
};
