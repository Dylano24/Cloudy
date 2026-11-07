import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  AUTO_WIPE_GUILD_ID, configureWipeAutomation, getWipeAutomationConfig,
  setWipeAutomationState,
} from '../../services/wipeAutomationService.js';

const typeOption = sub => sub.addStringOption(option => option
  .setName('type').setDescription('Choose the automation')
  .setRequired(true)
  .addChoices({ name: 'Map votes', value: 'vote' }, { name: 'Wipe giveaways', value: 'giveaway' }));

const slash = new SlashCommandBuilder()
  .setName('automation')
  .setDescription('Configure and control automated Rust wipe votes and kit giveaways.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub => sub.setName('vote')
    .setDescription('Configure a mapvote before the next real server wipe.')
    .addStringOption(opt => opt.setName('server').setDescription('Exact connected Rust server name').setRequired(true).setMaxLength(60))
    .addStringOption(opt => opt.setName('question').setDescription('Map vote question').setRequired(true).setMaxLength(250))
    .addStringOption(opt => opt.setName('map1').setDescription('First map').setRequired(true).setMaxLength(80))
    .addStringOption(opt => opt.setName('map2').setDescription('Second map').setRequired(true).setMaxLength(80))
    .addIntegerOption(opt => opt.setName('before_minutes').setDescription('Minutes before wipe to start (2–10080)').setRequired(true).setMinValue(2).setMaxValue(10080))
    .addIntegerOption(opt => opt.setName('duration_minutes').setDescription('Vote duration; must end before wipe').setRequired(true).setMinValue(1).setMaxValue(10079))
    .addStringOption(opt => opt.setName('map3').setDescription('Optional third map').setMaxLength(80)))
  .addSubcommand(sub => sub.setName('giveaway')
    .setDescription('Configure a kit giveaway before each actual Rust wipe.')
    .addStringOption(opt => opt.setName('server').setDescription('Exact connected Rust server name').setRequired(true).setMaxLength(60))
    .addStringOption(opt => opt.setName('kit').setDescription('Kit to win for the next wipe').setRequired(true).setMaxLength(150))
    .addRoleOption(opt => opt.setName('winner_role').setDescription('Temporary role for the selected kit winners').setRequired(true))
    .addIntegerOption(opt => opt.setName('winners').setDescription('Number of kit winners').setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(opt => opt.setName('before_minutes').setDescription('Minutes before wipe to start').setRequired(true).setMinValue(2).setMaxValue(10080))
    .addIntegerOption(opt => opt.setName('duration_minutes').setDescription('Giveaway duration; must end before wipe').setRequired(true).setMinValue(1).setMaxValue(10079)))
  .addSubcommand(sub => typeOption(sub.setName('start').setDescription('Start a configured automation.')))
  .addSubcommand(sub => typeOption(sub.setName('pause').setDescription('Pause an automation without losing its settings.')))
  .addSubcommand(sub => typeOption(sub.setName('resume').setDescription('Resume a paused automation.')))
  .addSubcommand(sub => typeOption(sub.setName('stop').setDescription('Stop an automation without deleting its settings.')))
  .addSubcommand(sub => sub.setName('status').setDescription('View configured automations and actual server wipe dates.'));

async function reply(interaction, text) {
  const payload = { content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  return interaction.reply(payload);
}
function summary(kind, config) {
  if (!config) return `${kind}: not configured`;
  return `${kind}: ${config.state} · ${config.server} · ${config.beforeMinutes} minutes before wipe`;
}

export default {
  slashOnly: true,
  data: slash,
  async execute(interaction) {
    if (interaction.guildId !== AUTO_WIPE_GUILD_ID ||
      !interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      return reply(interaction, 'Manage Server permission is required in Cloudy Inc.');
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'status') {
        const config = await getWipeAutomationConfig(interaction.client, interaction.guildId);
        const dates = Object.entries(config.wipes)
          .filter(([, date]) => Number.isFinite(Number(date)) && Number(date) > Date.now())
          .map(([server, date]) => `${server}: <t:${Math.floor(date / 1000)}:F>`);
        return reply(interaction, [
          summary('Map votes', config.vote), summary('Wipe giveaways', config.giveaway),
          ...dates,
        ].join('\n'));
      }
      if (sub === 'vote') {
        const maps = ['map1', 'map2', 'map3']
          .map(name => interaction.options.getString(name)?.trim()).filter(Boolean);
        await configureWipeAutomation(interaction.client, interaction.guildId, 'vote', {
          server: interaction.options.getString('server'),
          question: interaction.options.getString('question'),
          maps,
          beforeMinutes: interaction.options.getInteger('before_minutes'),
          durationMinutes: interaction.options.getInteger('duration_minutes'),
        });
        return reply(interaction, 'Mapvote configuration saved. Use /automation start to enable it.');
      }
      if (sub === 'giveaway') {
        const role = interaction.options.getRole('winner_role');
        const botMember = interaction.guild.members.me
          || await interaction.guild.members.fetchMe().catch(() => null);
        if (!role || role.managed || role.id === interaction.guild.id ||
          !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles) ||
          botMember.roles.highest.comparePositionTo(role) <= 0) {
          return reply(interaction, 'Choose a role that Cloudy can assign and remove.');
        }
        await configureWipeAutomation(interaction.client, interaction.guildId, 'giveaway', {
          server: interaction.options.getString('server'),
          kit: interaction.options.getString('kit'),
          winnerRoleId: role.id,
          winnerCount: interaction.options.getInteger('winners'),
          beforeMinutes: interaction.options.getInteger('before_minutes'),
          durationMinutes: interaction.options.getInteger('duration_minutes'),
        });
        return reply(interaction, 'Wipe giveaway configuration saved. Use /automation start to enable it.');
      }
      const kind = interaction.options.getString('type');
      const state = sub === 'start' || sub === 'resume' ? 'running' : sub === 'pause' ? 'paused' : 'stopped';
      const result = await setWipeAutomationState(interaction.client, interaction.guildId, kind, state);
      return reply(interaction, `${kind}: ${result.state}`);
    } catch (error) {
      return reply(interaction, error instanceof RangeError ? error.message : 'Automation settings could not be saved.');
    }
  },
};
