import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { addCreatorNotification, listCreatorNotifications, removeCreatorNotification } from '../../services/creatorNotificationService.js';
import { creatorProviderReady, CREATOR_PLATFORMS } from '../../services/creatorNotificationProviders.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR } from '../../utils/embedColorPolicy.js';
import { withCreatorErrorColor } from '../../utils/cloudyFooter.js';

const platforms = option => option.setName('platform').setDescription('Optional when pasting a profile link')
  .setRequired(false).addChoices(...CREATOR_PLATFORMS.map(platform => ({
    name: platform[0].toUpperCase() + platform.slice(1), value: platform,
  })));
const username = option => option.setName('creator')
  .setDescription('Paste a YouTube, Twitch or TikTok link, or enter a creator ID').setRequired(true);

async function respond(interaction, title, message, success = true) {
  const embed = success ? successEmbed(title, message) : errorEmbed(title, message, { showDetails: false });
  if (!success) embed.data.color = CLOUDY_RED_COLOR;
  const send = () => interaction.deferred || interaction.replied
    ? interaction.editReply({ embeds: [embed] })
    : interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  if (success) await send();
  else await withCreatorErrorColor(send);
  // Temporary command notices follow Cloudy's 10-second rule, including
  // invalid URL errors, permission errors and success confirmations.
  const timer = setTimeout(() => {
    if (typeof interaction.deleteReply === 'function') {
      void Promise.resolve().then(() => interaction.deleteReply()).catch(() => {});
    }
  }, 10_000);
  timer.unref?.();
}
export default {
  data: new SlashCommandBuilder()
    .setName('creator-notify')
    .setDescription('Automatically post new creator content to Discord')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Monitor a creator')
      .addStringOption(username).addStringOption(platforms)
      .addChannelOption(option => option.setName('channel')
        .setDescription('Destination (default: platform channel)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop monitoring a creator')
      .addStringOption(username).addStringOption(platforms))
    .addSubcommand(sub => sub.setName('list').setDescription('Show configured creator notifications')),
  // Discord limits guild commands to 100. Keep this feature as one global
  // application command; existing 100 guild commands stay untouched.
  globalRegistration: true,
  category: 'Tools',
  async execute(interaction, _config, client) {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return respond(interaction, 'Access denied', 'Manage Server permission is required.', false);
    }
    const bot = client || interaction.client;
    const action = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (action === 'add') {
        const platform = interaction.options.getString('platform');
        const creator = interaction.options.getString('creator');
        const channel = interaction.options.getChannel('channel');
        const entry = await addCreatorNotification(bot, interaction.guildId, platform, creator, channel?.id);
        const status = creatorProviderReady(entry.platform) ? 'Ready to monitor' : entry.platform === 'tiktok'
          ? 'Saved, but TikTok needs a trusted RSS bridge configured by the operator.'
          : 'Saved, but Twitch API credentials must be configured.';
        return respond(interaction, 'Creator added', '**' + entry.platform + ': ' + entry.account
          + '**\nDestination: ' + (channel ? '<#' + channel.id + '>' : 'the existing #' + entry.platform + ' channel')
          + '\n' + status + '\nExisting posts are skipped on first check; new posts are announced.');
      }
      if (action === 'remove') {
        const removed = await removeCreatorNotification(bot, interaction.guildId,
          interaction.options.getString('platform'), interaction.options.getString('creator'));
        return respond(interaction, removed ? 'Creator removed' : 'Not found',
          removed ? 'Automatic notifications for that creator are stopped.' : 'No matching creator was configured.', removed);
      }
      const items = await listCreatorNotifications(bot, interaction.guildId);
      if (!items.length) return respond(interaction, 'Creator notifications', 'No creators configured. Use /creator-notify add.');
      return respond(interaction, 'Creator notifications', items.map(item => {
        const destination = item.channelId ? '<#' + item.channelId + '>' : '#' + item.platform;
        const ready = creatorProviderReady(item.platform) ? (item.initialized ? 'Active' : 'Waiting for first check') : 'Needs provider setup';
        return '**' + item.platform + ' • ' + item.account + '** → ' + destination + '\n' + ready;
      }).join('\n\n').slice(0, 3800));
    } catch (error) {
      return respond(interaction, 'Creator notification error', error.message, false);
    }
  },
};
