import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, loadVote, optionPicture } from '../../../services/voteService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const PICTURE_LIFETIME_MS = 30_000;

// vote_media:<option index>: shows that option's picture privately under the
// vote, in an embed, and removes it after 30 seconds (owner's choice).
export default {
  name: 'vote_media',
  async execute(interaction, client, [index] = []) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const vote = await loadVote(client, interaction.guildId, interaction.message.id);
    const position = Number(index);
    const picture = vote ? optionPicture(vote, position) : null;
    if (!picture) {
      const reply = await interaction.editReply({ embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'This picture is no longer available.'), CLOUDY_RED_COLOR)] });
      const timer = setTimeout(() => { void interaction.deleteReply(reply).catch(() => {}); }, 10_000);
      timer.unref?.();
      return;
    }
    // Only the picture (owner's choice: no title, no logo).
    const reply = await interaction.editReply({ embeds: [{ image: { url: picture }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER } }] });
    const key = `vote-media:${interaction.id}`;
    const remove = () => interaction.deleteReply(reply).catch(() => {});
    const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, PICTURE_LIFETIME_MS);
    timer.unref?.();
    // A restart removes it at once instead of leaving it behind.
    registerPendingDelete(key, remove);
  },
};
