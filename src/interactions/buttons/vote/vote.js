import { MessageFlags } from 'discord.js';
import { successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { buildVoteMessage, castVote } from '../../../services/voteService.js';

// vote_cast:<option index> on a /vote message. The click is answered first,
// then the vote is saved, the counts refresh and a 10-second notice follows.
export default {
  name: 'vote_cast',
  async execute(interaction, client, [index] = []) {
    await interaction.deferUpdate();
    const result = await castVote(client, interaction.guildId, interaction.message.id, interaction.user.id, Number(index));
    if (result.vote) await interaction.editReply(buildVoteMessage(result.vote));
    const text = {
      voted: `You voted for **${result.option}**.`,
      changed: `Your vote is now **${result.option}**.`,
      removed: 'Your vote was removed.',
    }[result.status];
    const embed = text ? successEmbed('Success', text)
      : setPreservedEmbedColor(warningEmbed('Warning', result.status === 'ended' ? 'This vote has ended.' : 'This vote is no longer available.'), CLOUDY_RED_COLOR);
    const message = await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    const timer = setTimeout(() => { void interaction.deleteReply(message).catch(() => {}); }, 10_000);
    timer.unref?.();
  },
};
