import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getPartyPrompt, getPartyGameStats } from '../../services/partyGameService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const TYPE_LABELS = {
  truth: 'Truth',
  dare: 'Dare',
  tod: 'Truth or Dare',
  wyr: 'Would You Rather',
  nhie: 'Never Have I Ever',
  paranoia: 'Paranoia',
  random: 'Random',
};

function addModeOption(subcommand) {
  return subcommand.addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('Question rating')
      .addChoices(
        { name: 'PG', value: 'pg' },
        { name: 'PG-13', value: 'pg13' },
      ),
  );
}

function gameSubcommand(name, description) {
  return addModeOption(
    new SlashCommandBuilder().addSubcommand((sub) => sub).options?.[0] || null
  );
}

function addGameSubcommand(builder, name, description, { target = false } = {}) {
  return builder.addSubcommand((sub) => {
    sub.setName(name).setDescription(description);
    if (target) {
      sub.addUserOption((option) =>
        option
          .setName('target')
          .setDescription('Optionally send the prompt privately to this user')
          .setRequired(false),
      );
    }
    addModeOption(sub);
    return sub;
  });
}

const data = new SlashCommandBuilder()
  .setName('party')
  .setDescription('Party games: Truth or Dare, WYR, NHIE and Paranoia');

addGameSubcommand(data, 'truth', 'Get a truth question');
addGameSubcommand(data, 'dare', 'Get a dare');
addGameSubcommand(data, 'tod', 'Get a random truth or dare');
addGameSubcommand(data, 'wyr', 'Get a Would You Rather question');
addGameSubcommand(data, 'nhie', 'Get a Never Have I Ever prompt');
addGameSubcommand(data, 'paranoia', 'Get a Most Likely To / Paranoia question', { target: true });
addGameSubcommand(data, 'random', 'Get a random prompt from any party-game category');
data.addSubcommand((sub) =>
  sub
    .setName('info')
    .setDescription('Show the available party-game modes and prompt library'),
);

export default {
  category: 'Fun',
  data,

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'info') {
      const stats = getPartyGameStats();
      const fields = Object.entries(stats.byType).map(([type, counts]) => ({
        name: TYPE_LABELS[type] || type,
        value: `${counts.total} prompts (${counts.pg} PG + ${counts.pg13} PG-13)`,
        inline: true,
      }));

      return InteractionHelper.safeReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle('🎲 Cloudy Party Games')
            .setDescription(
              'Play Truth or Dare, Would You Rather, Never Have I Ever and Paranoia. ' +
              'Use **PG** for the safest set or **PG-13** for slightly more personal prompts.'
            )
            .addFields(fields)
            .setFooter({ text: `${stats.total} built-in prompts • More can be added without adding new slash commands` }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const mode = interaction.options.getString('mode') || 'pg';
    const result = getPartyPrompt(subcommand, mode);
    const target = subcommand === 'paranoia'
      ? interaction.options.getUser('target')
      : null;

    const embed = new EmbedBuilder()
      .setTitle(`🎲 ${TYPE_LABELS[result.type] || 'Party Game'}`)
      .setDescription(result.prompt)
      .addFields({ name: 'Mode', value: result.mode.toUpperCase(), inline: true })
      .setFooter({ text: `Requested by ${interaction.user.username}` })
      .setTimestamp();

    if (target) {
      try {
        await target.send({
          content: `You received a private **${TYPE_LABELS[result.type] || result.type}** prompt from ${interaction.user.tag}:`,
          embeds: [embed],
        });

        return InteractionHelper.safeReply(interaction, {
          content: `📩 Sent a private paranoia prompt to ${target}.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        return InteractionHelper.safeReply(interaction, {
          content: `I couldn't DM ${target}. They may have DMs disabled.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    return InteractionHelper.safeReply(interaction, { embeds: [embed] });
  },
};
