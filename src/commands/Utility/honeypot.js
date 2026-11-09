import {
  ApplicationIntegrationType, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { honeypotEmbed, loadHoneypot, setHoneypot, setHoneypotEnabled } from '../../services/honeypotService.js';
import { logger } from '../../utils/logger.js';

function settingsEmbed(config) {
  if (!config) return honeypotEmbed('Honeypot', '**Status:** Off\nUse `/honeypot setup` to configure it.');
  return honeypotEmbed('Honeypot', [
    '**Status:** ' + (config.enabled ? 'On' : 'Off'),
    '**Channel:** <#' + config.channelId + '>',
    '**Alerts:** <#' + config.logChannelId + '>',
    '**Mode:** ' + (config.mode === 'kick' ? 'Kick' : 'Monitor only'),
  ].join('\n'), config.enabled ? 0x00C49D : 0xFFFFFF);
}

export default {
  slashOnly: true,
  globalRegistration: true,
  data: new SlashCommandBuilder()
    .setName('honeypot')
    .setDescription('Manage the Cloudy Inc. honeypot.')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('setup').setDescription('Configure and enable the honeypot.')
      .addChannelOption(option => option.setName('channel').setDescription('Honeypot channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption(option => option.setName('logs').setDescription('Separate alert channel.')
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(option => option.setName('mode').setDescription('Action when someone posts. Defaults to monitoring.')
        .addChoices({ name: 'Monitor only', value: 'monitor' }, { name: 'Kick (staff exempt)', value: 'kick' })))
    .addSubcommand(sub => sub.setName('on').setDescription('Enable the honeypot using the saved settings.'))
    .addSubcommand(sub => sub.setName('off').setDescription('Disable the honeypot and keep its settings.'))
    .addSubcommand(sub => sub.setName('status').setDescription('View the honeypot settings.')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('You need Manage Server permission.');
      }
      const { client, guildId, guild, options } = interaction;
      const action = options.getSubcommand();
      let config;
      if (action === 'setup') {
        const channel = options.getChannel('channel', true);
        const logs = options.getChannel('logs', true);
        if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ViewChannel)) {
          throw new Error('Cloudy needs View Channel in the honeypot channel.');
        }
        if (!logs.permissionsFor(guild.members.me)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ])) throw new Error('Cloudy needs View Channel, Send Messages and Embed Links in the alert channel.');
        config = await setHoneypot(client, guildId, channel.id, logs.id, options.getString('mode') ?? 'monitor');
      } else if (action === 'on' || action === 'off') {
        config = await setHoneypotEnabled(client, guildId, action === 'on');
      } else {
        config = await loadHoneypot(client, guildId);
      }
      return interaction.editReply({ embeds: [settingsEmbed(config)], allowedMentions: { parse: [] } });
    } catch (error) {
      logger.warn('[HONEYPOT] Command failed:', error);
      return interaction.editReply({ embeds: [honeypotEmbed('Something went wrong', error.message, 0x7A1712)] });
    }
  },
};
