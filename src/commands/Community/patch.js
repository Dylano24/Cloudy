import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  getLatestPatch,
  getEpicFreeGames,
  getPatchSubscriptions,
} from '../../services/patchFeedService.js';

function patchEmbed(feed, item) {
  const embed = new EmbedBuilder()
    .setTitle(item.title || 'Latest Update')
    .setDescription(String(item.description || 'No description available.').slice(0, 3500))
    .setFooter({ text: `${feed.title} • ${feed.provider.toUpperCase()}` })
    .setTimestamp(item.publishedAt ? new Date(item.publishedAt) : new Date());
  if (item.url) embed.setURL(item.url);
  return embed;
}

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('patch')
    .setDescription('Patch notes, releases and free-game information')
    .addSubcommand((sub) =>
      sub
        .setName('steam')
        .setDescription('Show the latest news/patch entry for a Steam game')
        .addStringOption((option) =>
          option.setName('app').setDescription('Steam App ID or store URL').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('github')
        .setDescription('Show the latest GitHub release for a project')
        .addStringOption((option) =>
          option.setName('repository').setDescription('Repository, e.g. owner/repo').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('feed')
        .setDescription('Show the latest item from an RSS/Atom update feed')
        .addStringOption((option) =>
          option.setName('url').setDescription('RSS/Atom feed URL').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('freebies')
        .setDescription('Show current and upcoming Epic free-game promotions')
        .addStringOption((option) =>
          option.setName('country').setDescription('Country code, e.g. NL, FR, US').setMaxLength(2),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('subscriptions').setDescription('Show update feeds configured for this server'),
    ),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();
    await InteractionHelper.safeDefer(interaction);

    try {
      if (subcommand === 'steam') {
        const result = await getLatestPatch('steam', interaction.options.getString('app', true));
        if (!result.item) throw new Error('No Steam news was found for that app.');
        return InteractionHelper.safeEditReply(interaction, { embeds: [patchEmbed(result.feed, result.item)] });
      }

      if (subcommand === 'github') {
        const result = await getLatestPatch('github', interaction.options.getString('repository', true));
        if (!result.item) throw new Error('No GitHub releases were found for that repository.');
        return InteractionHelper.safeEditReply(interaction, { embeds: [patchEmbed(result.feed, result.item)] });
      }

      if (subcommand === 'feed') {
        const result = await getLatestPatch('rss', interaction.options.getString('url', true));
        if (!result.item) throw new Error('No update entries were found in that feed.');
        return InteractionHelper.safeEditReply(interaction, { embeds: [patchEmbed(result.feed, result.item)] });
      }

      if (subcommand === 'freebies') {
        const country = (interaction.options.getString('country') || 'US').toUpperCase();
        const games = await getEpicFreeGames({ country });
        if (!games.length) throw new Error('No Epic free-game promotions were found right now.');

        const active = games.filter((game) => game.active);
        const upcoming = games.filter((game) => !game.active);
        const lines = [
          ...active.map((game) =>
            `🎁 **[${game.title}](${game.url})** — free now${game.endAt ? ` until <t:${Math.floor(new Date(game.endAt).getTime() / 1000)}:R>` : ''}`
          ),
          ...upcoming.map((game) =>
            `⏳ **[${game.title}](${game.url})** — upcoming${game.startAt ? ` <t:${Math.floor(new Date(game.startAt).getTime() / 1000)}:R>` : ''}`
          ),
        ];

        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`🎮 Free Games — ${country}`)
              .setDescription(lines.join('\n').slice(0, 4000))
              .setFooter({ text: 'Epic Games promotions • availability can vary by region' })
              .setTimestamp(),
          ],
        });
      }

      if (subcommand === 'subscriptions') {
        const subscriptions = await getPatchSubscriptions(client, interaction.guildId);
        if (!subscriptions.length) {
          return InteractionHelper.safeEditReply(interaction, {
            content: 'No update subscriptions are configured for this server.',
          });
        }

        const lines = subscriptions.map((entry) =>
          `• \`${entry.id}\` **${entry.label}** — ${entry.provider.toUpperCase()} → <#${entry.discordChannelId}>`
        );
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('📰 Update Subscriptions')
              .setDescription(lines.join('\n').slice(0, 4000)),
          ],
        });
      }
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `❌ ${error?.message || 'Update lookup failed.'}`,
        embeds: [],
        components: [],
      });
    }
  },
};
