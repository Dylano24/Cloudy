import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { activeVotes, endVoteNow } from '../../services/voteService.js';

// Discord waits 3 seconds for the answer.
const ANSWER_WITHIN_MS = 2_000;
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});
const warning = text => setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR);

// Short replies disappear after exactly 10 seconds.
function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

// The question with its channel, so two votes with the same question differ.
function voteLabel(vote, guild) {
  const channel = guild?.channels?.cache?.get?.(vote.channelId)?.name;
  return `${vote.question}${channel ? ` · #${channel}` : ''}`.slice(0, 100);
}

async function endChosenVote(interaction, value) {
  const votes = await activeVotes(interaction.client, interaction.guildId);
  // The vote picked from the list, or a typed question that matches one open vote.
  const typed = votes.filter(vote => vote.question.toLowerCase() === value.toLowerCase());
  const vote = votes.find(entry => entry.messageId === value) || (typed.length === 1 ? typed[0] : null);
  if (!vote) return warning('This vote is not open. Choose a vote from the list.');
  const result = await endVoteNow(interaction.client, interaction.guild, vote.messageId);
  if (result.status !== 'ended') return warning('This vote has already ended.');
  return successEmbed('Success', 'The vote has ended.');
}

// /endvote (owner's choice, staff): ends an open vote at once, exactly as when
// its time runs out (no buttons, result under the vote).
export default {
  data: new SlashCommandBuilder()
    .setName('endvote')
    .setDescription('End an open vote now.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('vote').setDescription('The vote to end').setRequired(true).setAutocomplete(true)),

  async autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() || '').trim().toLowerCase();
    const votes = await activeVotes(interaction.client, interaction.guildId);
    await interaction.respond(votes
      .filter(vote => !typed || vote.question.toLowerCase().includes(typed))
      .slice(0, 25)
      .map(vote => ({ name: voteLabel(vote, interaction.guild), value: vote.messageId })));
  },

  async execute(interaction) {
    if (!interaction.inGuild?.() || !interaction.guild) {
      await interaction.reply({ embeds: [warning('Votes only work in a server channel.')], flags: MessageFlags.Ephemeral });
      removeAfterTenSeconds(interaction);
      return;
    }
    const ending = endChosenVote(interaction, interaction.options.getString('vote', true).trim());
    // One answer, no "thinking", when it is done within 2 seconds.
    let embed = await Promise.race([ending, wait(ANSWER_WITHIN_MS)]);
    if (embed) {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      embed = await ending;
      await interaction.editReply({ embeds: [embed] });
    }
    removeAfterTenSeconds(interaction);
  },
};
