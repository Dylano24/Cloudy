import { MessageFlags } from 'discord.js';
import { successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, buildVoteMessage, castVote, votePicture } from '../../../services/voteService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const NOTICE_MS = 10_000;
export const PICTURE_NOTICE_MS = 30_000;

// vote_cast:<option index>: the option's button (digit and name). The click is
// answered first, then the vote is saved and the counts refresh. A private
// notice follows: with the option's picture (owner's choice: one button for
// option and media) for 30 seconds, otherwise the usual 10-second notice.
export default {
  name: 'vote_cast',
  async execute(interaction, client, [index] = []) {
    await interaction.deferUpdate();
    const position = Number(index);
    const result = await castVote(client, interaction.guildId, interaction.message.id, interaction.user.id, position);
    if (result.vote && result.status !== 'unchanged') await interaction.editReply(buildVoteMessage(result.vote));
    const text = {
      voted: `You voted for **${result.option}**.`,
      unchanged: `You voted for **${result.option}**.`,
      changed: `Your vote is now **${result.option}**.`,
    }[result.status];
    const picture = text ? votePicture(result.vote, position) : null;
    let embed;
    if (picture) {
      // The picture under the vote, no title or logo (owner's choice).
      embed = { description: text, image: { url: picture }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER } };
    } else {
      embed = text ? successEmbed('Success', text)
        : setPreservedEmbedColor(warningEmbed('Warning', result.status === 'ended' ? 'This vote has ended.' : 'This vote is no longer available.'), CLOUDY_RED_COLOR);
    }
    const message = await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    const key = `vote-notice:${interaction.id}`;
    const remove = () => interaction.deleteReply(message).catch(() => {});
    const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, picture ? PICTURE_NOTICE_MS : NOTICE_MS);
    timer.unref?.();
    // A restart removes it at once instead of leaving it behind.
    registerPendingDelete(key, remove);
  },
};
