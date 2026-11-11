import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openCloudyFeedDashboard } from '../../services/cloudyFeedDashboardService.js';
import { openAutomationDashboard } from '../../services/automationBuilderService.js';
import {
  AUTO_WIPE_GUILD_ID, AUTOMATION_COMMAND_STATES, automationLabel, listAutomationsForCommand, setAutomationsState,
} from '../../services/wipeAutomationService.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';

const STATE_WORDS = { start: 'started', pause: 'paused', stop: 'stopped' };

// start / pause / stop: which automations (all, votes or giveaways) and
// optionally one of them, picked from the list while typing.
const controlCommand = (name, description) => command => command
  .setName(name)
  .setDescription(description)
  .addStringOption(option => option.setName('type').setDescription('Votes, giveaways or both')
    .setRequired(true)
    .addChoices({ name: 'All', value: 'all' }, { name: 'Votes', value: 'vote' }, { name: 'Giveaways', value: 'giveaway' }))
  .addStringOption(option => option.setName('automation').setDescription('Only this automation (optional)')
    .setRequired(false).setAutocomplete(true));

function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

async function controlAutomations(interaction, client, action) {
  if (interaction.guildId !== AUTO_WIPE_GUILD_ID || !interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'Manage Server permission is required in Cloudy Inc.'), CLOUDY_RED_COLOR)], flags: MessageFlags.Ephemeral });
    return removeAfterTenSeconds(interaction);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = await setAutomationsState(client || interaction.client, interaction.guildId, {
    kind: interaction.options.getString('type') || 'all',
    state: AUTOMATION_COMMAND_STATES[action],
    jobId: interaction.options.getString('automation') || null,
  });
  if (!results.length) {
    await interaction.editReply({ embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'No saved automation matches. Create one with /auto vote or /auto giveaway.'), CLOUDY_RED_COLOR)] });
    return removeAfterTenSeconds(interaction);
  }
  const line = result => result.status === 'changed' ? `**${result.label}**: ${STATE_WORDS[action]}`
    : result.status === 'unchanged' ? `**${result.label}**: already ${STATE_WORDS[action]}`
      : result.status === 'not-running' ? `**${result.label}**: not running`
        : `**${result.label}**: ${result.reason}`;
  const failed = results.some(result => result.status === 'failed');
  const text = results.map(line).join('\n').slice(0, 4000);
  await interaction.editReply({ embeds: [failed
    ? setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR)
    : successEmbed('Success', text)] });
  return removeAfterTenSeconds(interaction);
}

export default {
  data: new SlashCommandBuilder()
    .setName('auto')
    .setDescription('Owner-only automatic features')
    // Default disabled: server Integration settings can enable this for the Owner role.
    // Role membership is independently verified in every handler.
    .setDefaultMemberPermissions(0n)
    .setDMPermission(false)
    .addSubcommand(command => command
      .setName('feed')
      .setDescription('Open the Cloudy feed dashboard'))
    .addSubcommand(command => command
      .setName('giveaway')
      .setDescription('Open the automatic giveaway builder'))
    .addSubcommand(command => command
      .setName('vote')
      .setDescription('Open the automatic vote builder'))
    .addSubcommand(controlCommand('start', 'Start (or resume) automatic votes and giveaways'))
    .addSubcommand(controlCommand('pause', 'Pause running automatic votes and giveaways'))
    .addSubcommand(controlCommand('stop', 'Stop automatic votes and giveaways')),

  category: 'Tools',
  adminOnly: false,

  async execute(interaction, _config, client) {
    const sub = interaction.options.getSubcommand(false);
    if (sub === 'feed') return openCloudyFeedDashboard(interaction, client);
    if (sub === 'vote' || sub === 'giveaway') return openAutomationDashboard(interaction, sub);
    if (Object.hasOwn(AUTOMATION_COMMAND_STATES, sub)) return controlAutomations(interaction, client, sub);
  },

  async autocomplete(interaction, client) {
    if (interaction.guildId !== AUTO_WIPE_GUILD_ID || !interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      return interaction.respond([]);
    }
    const type = interaction.options.getString('type') || 'all';
    const typed = String(interaction.options.getFocused() || '').toLowerCase();
    const entries = (await listAutomationsForCommand(client || interaction.client, interaction.guildId))
      .filter(entry => type === 'all' || entry.kind === type)
      .map(entry => ({ name: `${automationLabel(entry.kind, entry.job)} (${entry.job.state || 'stopped'})`.slice(0, 100), value: `${entry.kind}:${entry.job.id}` }))
      .filter(choice => choice.name.toLowerCase().includes(typed))
      .slice(0, 25);
    return interaction.respond(entries);
  },
};
