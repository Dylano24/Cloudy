import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, loadVote, optionPicture } from '../../../services/voteService.js';

// vote_media:<option index>: shows that option's picture (e.g. its map) in a
// private message, so it opens inside Discord at its own size (owner's choice).
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
    await interaction.editReply({ embeds: [{
      title: vote.options[position],
      image: { url: picture },
      color: 0xFFFFFF,
      thumbnail: { url: CLOUDY_C_LOGO_URL },
      footer: { text: CLOUDY_FOOTER },
    }] });
  },
};
