import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, loadVote, voteNumberIcon, votePicture } from '../../../services/voteService.js';
import { freshVotePictureLinks } from '../../../services/voteMediaService.js';
import { shrinkVotePicture, votePreviewFile } from '../../../services/votePreviewService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const PICTURE_LIFETIME_MS = 30_000;
export const NOTICE_MS = 10_000;
// Discord waits 3 seconds for the answer.
export const ANSWER_WITHIN_MS = 2_000;
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});

async function previewAnswer(client, interaction, which, fetchImpl, shrink) {
  const vote = await loadVote(client, interaction.guildId, interaction.message.id);
  // "all" (owner's choice: one Preview beside the choices) shows every
  // option's picture; an index (older votes) shows that one.
  const positions = !vote ? [] : which === 'all'
    ? vote.options.map((_, index) => index).filter(index => (vote.pictureOptions ? vote.pictureOptions[index] : votePicture(vote, index)))
    : [Number(which)];
  const pictures = [];
  for (const position of positions) {
    const url = votePicture(vote, position);
    // The small copy (votePreviewService.js), made when the vote was posted.
    const file = await votePreviewFile({
      messageId: vote.messageId, position, url, fetchImpl, shrink,
      // Discord's picture link may have expired: ask for a fresh one.
      refresh: vote.optionMedia ? async () => (await freshVotePictureLinks(client, vote.optionMedia))?.[position] : null,
    });
    if (file || url) pictures.push({ position, file, url });
  }
  if (!pictures.length) {
    return {
      payload: { embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'This picture is no longer available.'), CLOUDY_RED_COLOR)] },
      lifetime: NOTICE_MS,
    };
  }
  // Each picture with its number and the option's name (owner's choice: no
  // title, no logo, no dropdown). Every picture has the Cloudy footer: Cloudy's
  // automatic logo (withCloudyFooter) is only added to embeds without one.
  return {
    payload: {
      embeds: pictures.map(({ position, file, url }) => ({
        description: `${voteNumberIcon(position)} **${vote.options[position]}**`,
        image: { url: file ? `attachment://${file.name}` : url },
        color: 0xFFFFFF,
        footer: { text: CLOUDY_FOOTER },
      })),
      files: pictures.flatMap(({ file }) => (file ? [file] : [])),
    },
    lifetime: PICTURE_LIFETIME_MS,
  };
}

// vote_media:<option index>: the small Preview button next to an option (also
// the picture buttons of older votes). Shows that option's picture privately
// under the vote, with the option's name, and removes it after 30 seconds.
// The answer is prepared first and sent in one step (owner's choice): a
// "thinking" reply that was filled in afterwards made the vote's bars flicker.
// Only when preparing takes longer than 2 seconds is the click acknowledged first.
export default {
  name: 'vote_media',
  async execute(interaction, client, [index] = [], dependencies = {}) {
    const preparing = previewAnswer(client, interaction, index, dependencies.fetchImpl || fetch, dependencies.shrink || shrinkVotePicture);
    let answer = await Promise.race([preparing, wait(ANSWER_WITHIN_MS)]);
    if (answer) {
      await interaction.reply({ ...answer.payload, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      answer = await preparing;
      await interaction.editReply(answer.payload);
    }
    const key = `vote-media:${interaction.id}`;
    const remove = () => interaction.deleteReply().catch(() => {});
    const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, answer.lifetime);
    timer.unref?.();
    // A restart removes it at once instead of leaving it behind.
    registerPendingDelete(key, remove);
  },
};
