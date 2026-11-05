import { MessageFlags } from 'discord.js';
import { successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { buildVoteMessage, castVote } from '../../../services/voteService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const NOTICE_MS = 10_000;
// Saving a vote normally takes milliseconds; Discord waits 3 seconds.
export const ANSWER_WITHIN_MS = 2_000;

const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});

// vote_cast:<option index>: the option's button (digit and name) only votes
// (owner's choice: the picture opens from the option's blue link). The click
// is answered in one step with the updated vote, so the message changes once
// (acknowledging first and editing after made the bars flicker). Only when
// saving takes longer than 2 seconds is the click acknowledged first.
// A private 10-second notice follows.
export default {
  name: 'vote_cast',
  async execute(interaction, client, [index] = []) {
    const saving = castVote(client, interaction.guildId, interaction.message.id, interaction.user.id, Number(index));
    let result = await Promise.race([saving, wait(ANSWER_WITHIN_MS)]);
    const refresh = outcome => outcome.vote && outcome.status !== 'unchanged';
    if (result) {
      if (refresh(result)) await interaction.update(buildVoteMessage(result.vote));
      else await interaction.deferUpdate();
    } else {
      await interaction.deferUpdate();
      result = await saving;
      if (refresh(result)) await interaction.editReply(buildVoteMessage(result.vote));
    }
    const text = {
      voted: `You voted for **${result.option}**.`,
      unchanged: `You voted for **${result.option}**.`,
      changed: `Your vote is now **${result.option}**.`,
    }[result.status];
    const embed = text ? successEmbed('Success', text)
      : setPreservedEmbedColor(warningEmbed('Warning', result.status === 'ended' ? 'This vote has ended.' : 'This vote is no longer available.'), CLOUDY_RED_COLOR);
    const message = await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    const key = `vote-notice:${interaction.id}`;
    const remove = () => interaction.deleteReply(message).catch(() => {});
    const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, NOTICE_MS);
    timer.unref?.();
    // A restart removes it at once instead of leaving it behind.
    registerPendingDelete(key, remove);
  },
};
