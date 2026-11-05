import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, loadVote, optionPicture } from '../../../services/voteService.js';

// vote_media:<option index>: buttons on votes from before the picture links;
// shows that option's picture privately inside Discord.
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
    await interaction.editReply({ embeds: [{ image: { url: picture }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER } }] });
  },
};
