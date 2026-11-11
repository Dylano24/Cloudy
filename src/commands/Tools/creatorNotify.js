import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { addCreatorNotification, checkCreatorNotifications, listCreatorNotifications, removeCreatorNotification } from '../../services/creatorNotificationService.js';
import { creatorProviderReady, CREATOR_PLATFORMS } from '../../services/creatorNotificationProviders.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';

const platforms = option => option.setName('platform').setDescription('Platform')
  .setRequired(true).addChoices(...CREATOR_PLATFORMS.map(platform => ({
    name: platform[0].toUpperCase() + platform.slice(1), value: platform,
  })));
const username = option => option.setName('creator')
  .setDescription('YouTube UC channel ID, Twitch username or TikTok username').setRequired(true);

async function respond(interaction, title, message, success = true) {
  const embed = success ? successEmbed(title, message) : warningEmbed(title, message);
  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
  else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
export default {
  data: new SlashCommandBuilder()
    .setName('creator-notify')
    .setDescription('Automatically post new creator content to Discord')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Monitor a creator')
      .addStringOption(platforms).addStringOption(username)
      .addChannelOption(option => option.setName('channel')
        .setDescription('Destination (default: platform channel)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop monitoring a creator')
      .addStringOption(platforms).addStringOption(username))
    .addSubcommand(sub => sub.setName('list').setDescription('Show configured creator notifications'))
    .addSubcommand(sub => sub.setName('check').setDescription('Check for new posts now')),
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
        const status = creatorProviderReady(platform) ? 'Ready to monitor' : platform === 'tiktok'
          ? 'Saved, but TikTok needs a trusted RSS bridge configured by the operator.'
          : 'Saved, but Twitch API credentials must be configured.';
        return respond(interaction, 'Creator added', '**' + entry.platform + ': ' + entry.account
          + '**\nDestination: ' + (channel ? '<#' + channel.id + '>' : 'the existing #' + platform + ' channel')
          + '\n' + status + '\nExisting posts are skipped on first check; new posts are announced.');
      }
      if (action === 'remove') {
        const removed = await removeCreatorNotification(bot, interaction.guildId,
          interaction.options.getString('platform'), interaction.options.getString('creator'));
        return respond(interaction, removed ? 'Creator removed' : 'Not found',
          removed ? 'Automatic notifications for that creator are stopped.' : 'No matching creator was configured.', removed);
      }
      if (action === 'check') {
        const sent = await checkCreatorNotifications(bot, interaction.guildId);
        return respond(interaction, 'Creator notifications checked',
          sent ? sent + ' new notification(s) posted.' : 'No new posts found. First checks only establish a baseline.');
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
