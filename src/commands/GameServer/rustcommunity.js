import {
  ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from '../../services/gameFeedService.js';
import {
  addRustServer, buildServerSelector, disableRustHoneypot, ensureRustCommunityForums,
  loadRustCommunityConfig, publishRustSelector, removeRustServer,
  setRustHoneypot, statusRustCommunityEmbed,
} from '../../services/rustCommunityExtrasService.js';
import { logger } from '../../utils/logger.js';
import { readAdvancedRustLeaderboard } from '../../services/advancedRustLeaderboardService.js';
import {
  getRustLiveBoardConfig, startRustLiveBoard, stopRustLiveBoard,
} from '../../services/rustLiveLeaderboardService.js';
import {
  disableRustRestartSchedule, getRustRestartConfig, publishRustRestartSchedule,
} from '../../services/rustRestartScheduleService.js';

const response = (title, description, color = 0xFFFFFF) => ({
  embeds: [{
    title, description, color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  }],
  allowedMentions: { parse: [] },
});

async function refreshPanel(interaction, config) {
  if (!config.panel) return;
  const channel = await interaction.guild.channels.fetch(config.panel.channelId).catch(() => null);
  const message = await channel?.messages?.fetch(config.panel.messageId).catch(() => null);
  if (message) await message.edit(buildServerSelector(config, interaction.guild));
}

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('rustcommunity')
    .setDescription('Manage additional Rust community features.')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('server-add')
      .setDescription('Add a server role to the selector.')
      .addRoleOption(option => option.setName('role').setDescription('Role for this Rust server.').setRequired(true))
      .addStringOption(option => option.setName('name').setDescription('Server name.').setMinLength(1).setMaxLength(80).setRequired(true)))
    .addSubcommand(sub => sub.setName('server-remove')
      .setDescription('Remove a Rust server from the selector.')
      .addRoleOption(option => option.setName('role').setDescription('Server role to remove.').setRequired(true)))
    .addSubcommand(sub => sub.setName('server-post')
      .setDescription('Post or update the server selector.')
      .addChannelOption(option => option.setName('channel').setDescription('Where to post the selector.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sub => sub.setName('honeypot-set')
      .setDescription('Set up an optional honeypot channel.')
      .addChannelOption(option => option.setName('channel').setDescription('Honeypot channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption(option => option.setName('logs').setDescription('Separate alert channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(option => option.setName('mode').setDescription('What happens when someone posts there.')
        .setRequired(true).addChoices(
          { name: 'Monitor only', value: 'monitor' },
          { name: 'Kick (staff members are exempt)', value: 'kick' },
        )))
    .addSubcommand(sub => sub.setName('honeypot-off').setDescription('Disable the honeypot.'))
    .addSubcommand(sub => sub.setName('forums').setDescription('Create missing Rust community forum channels.'))
    .addSubcommand(sub => sub.setName('restart-set')
      .setDescription('Schedule Discord restart notices (does not restart Rust).')
      .addChannelOption(option => option.setName('channel').setDescription('Announcement channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(option => option.setName('times').setDescription('Amsterdam time: 06:00, 18:00.')
        .setRequired(true))
      .addIntegerOption(option => option.setName('reminder').setDescription('Minutes before each restart (0–60).')
        .setMinValue(0).setMaxValue(60).setRequired(false)))
    .addSubcommand(sub => sub.setName('restart-off').setDescription('Disable scheduled restart notices.'))
    .addSubcommand(sub => sub.setName('liveboard-start')
      .setDescription('Start a live Rust leaderboard in one Discord message.')
      .addChannelOption(option => option.setName('channel').setDescription('Leaderboard channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(option => option.setName('server').setDescription('Optional exact Rust server name.')
        .setMaxLength(60).setRequired(false)))
    .addSubcommand(sub => sub.setName('liveboard-stop')
      .setDescription('Stop updating the live Rust leaderboard.'))
    .addSubcommand(sub => sub.setName('status').setDescription('View the Rust community settings.'))
    .addSubcommand(sub => sub.setName('leaderboard')
      .setDescription('View Rust kills, deaths and K/D.')
      .addStringOption(option => option.setName('server').setDescription('Optional Rust server name.')
        .setMaxLength(60).setRequired(false))
      .addBooleanOption(option => option.setName('public').setDescription('Post publicly (staff only).')
        .setRequired(false))),

  async execute(interaction) {
    const name = interaction.options.getSubcommand();
    const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    const publicLeaderboard = name === 'leaderboard' && isStaff
      && interaction.options.getBoolean('public') === true;
    await interaction.deferReply(publicLeaderboard ? {} : { flags: MessageFlags.Ephemeral });
    try {
      if (!interaction.inGuild()) throw new Error('This command works in a server only.');
      if (name === 'leaderboard') {
        const embeds = await readAdvancedRustLeaderboard(
          interaction.client, interaction.guildId, interaction.options.getString('server'));
        return interaction.editReply({ embeds, allowedMentions: { parse: [] } });
      }
      if (!isStaff) throw new Error('You need Manage Server permission.');
      if (name === 'server-add') {
        const config = await addRustServer(interaction.client, interaction.guild,
          interaction.options.getRole('role'), interaction.options.getString('name'));
        await refreshPanel(interaction, config);
        return interaction.editReply(response('Server added', 'The server selector has been updated.', 0x00C49D));
      }
      if (name === 'server-remove') {
        const config = await removeRustServer(interaction.client, interaction.guildId, interaction.options.getRole('role').id);
        await refreshPanel(interaction, config);
        return interaction.editReply(response('Server removed', 'The server selector has been updated.'));
      }
      if (name === 'server-post') {
        const channel = interaction.options.getChannel('channel');
        if (!channel?.permissionsFor(interaction.guild.members.me)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ])) throw new Error('Cloudy needs View Channel, Send Messages and Embed Links.');
        const sent = await publishRustSelector(interaction.client, interaction.guild, channel);
        return interaction.editReply(response('Server selector posted', 'Updated <#' + sent.channelId + '> in place.', 0x00C49D));
      }
      if (name === 'honeypot-set') {
        const channel = interaction.options.getChannel('channel');
        const logs = interaction.options.getChannel('logs');
        if (!logs.permissionsFor(interaction.guild.members.me)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ])) throw new Error('Cloudy needs access to the log channel.');
        const mode = interaction.options.getString('mode');
        await setRustHoneypot(interaction.client, interaction.guildId, channel.id, logs.id, mode);
        return interaction.editReply(response('Honeypot configured',
          '**Channel:** <#' + channel.id + '>\n**Mode:** ' + mode + '\n**Logs:** <#' + logs.id + '>', 0x00C49D));
      }
      if (name === 'honeypot-off') {
        await disableRustHoneypot(interaction.client, interaction.guildId);
        return interaction.editReply(response('Honeypot disabled', 'No further honeypot actions will run.'));
      }
      if (name === 'forums') {
        if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
          throw new Error('Cloudy needs Manage Channels permission.');
        }
        const result = await ensureRustCommunityForums(interaction.guild);
        const info = result.map(item => item.name + ': ' + (item.created ? 'Created'
          : item.supported ? 'Already exists' : 'Name already used by another channel type')).join('\n');
        return interaction.editReply(response('Rust community forums', info, 0x00C49D));
      }
      if (name === 'restart-set') {
        const channel = interaction.options.getChannel('channel');
        if (!channel?.permissionsFor(interaction.guild.members.me)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ])) throw new Error('Cloudy needs View Channel, Send Messages and Embed Links.');
        const config = await publishRustRestartSchedule(interaction.client, interaction.guild, channel,
          interaction.options.getString('times'), interaction.options.getInteger('reminder') ?? 15);
        return interaction.editReply(response('Restart notices scheduled',
          '**Times:** ' + config.times.join(', ') + '\n**Channel:** <#' + channel.id + '>', 0x00C49D));
      }
      if (name === 'restart-off') {
        await disableRustRestartSchedule(interaction.client, interaction.guildId);
        return interaction.editReply(response('Restart notices disabled', 'No further restart notices will be sent.'));
      }
      if (name === 'liveboard-start') {
        const sourceGuildId = String(process.env.GUILD_ID || interaction.guildId);
        const sourceGuild = interaction.client.guilds.cache.get(sourceGuildId);
        if (!sourceGuild) throw new Error('Source server is not connected to Cloudy.');
        if (sourceGuildId !== interaction.guildId) {
          const sourceMember = await sourceGuild.members.fetch(interaction.user.id).catch(() => null);
          if (!sourceMember?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
            throw new Error('You must manage both Discord servers to share Rust statistics.');
          }
        }
        const channel = interaction.options.getChannel('channel');
        const result = await startRustLiveBoard(interaction.client, interaction.guild, channel,
          sourceGuildId, interaction.options.getString('server'));
        return interaction.editReply(response('Live leaderboard enabled',
          'The leaderboard will update in <#' + channel.id + '> as Rust events arrive.\n'
          + 'Message: ' + result.message.url, 0x00C49D));
      }
      if (name === 'liveboard-stop') {
        await stopRustLiveBoard(interaction.client, interaction.guildId);
        return interaction.editReply(response('Live leaderboard paused',
          'The last leaderboard message is preserved. No further updates will run.'));
      }
      const config = await loadRustCommunityConfig(interaction.client, interaction.guildId);
      const restart = await getRustRestartConfig(interaction.client, interaction.guildId);
      const dashboard = statusRustCommunityEmbed(config, interaction.guild);
      dashboard.description += '\n**Restart notices:** ' + (restart?.enabled ? restart.times.join(', ') : 'Off');
      const live = await getRustLiveBoardConfig(interaction.client, interaction.guildId);
      dashboard.description += '\n**Live leaderboard:** ' + (live?.enabled ? '<#' + live.channelId + '>' : 'Off');
      return interaction.editReply({ embeds: [dashboard] });
    } catch (error) {
      logger.warn('[RUST_COMMUNITY] Command failed:', error);
      return interaction.editReply(response('Something went wrong', error.message || 'Please try again.', 0x7A1712));
    }
  },
};
