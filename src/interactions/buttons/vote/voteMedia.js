import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, loadVote, votePicture } from '../../../services/voteService.js';
import { freshVotePictureLinks } from '../../../services/voteMediaService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const PICTURE_LIFETIME_MS = 30_000;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

async function download(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length && buffer.length <= MAX_PICTURE_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

// The picture goes along as a file: Discord then knows its size at once and
// shows the whole message straight away (with only a link, the small embed
// with just the footer appeared first and the picture popped in later).
async function pictureFile(client, vote, position, url, fetchImpl) {
  let buffer = await download(url, fetchImpl);
  if (!buffer && vote.optionMedia) {
    // Discord's picture link may have expired: ask for a fresh one.
    const fresh = (await freshVotePictureLinks(client, vote.optionMedia).catch(() => null))?.[position];
    if (fresh) buffer = await download(fresh, fetchImpl);
  }
  if (!buffer) return null;
  const extension = String(new URL(url).pathname).match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase() || 'png';
  return { attachment: buffer, name: `option${position + 1}.${extension}` };
}

// vote_media:<option index>: the small Preview button next to an option (also
// the picture buttons of older votes). Shows that option's picture privately
// under the vote, with the option's name, and removes it after 30 seconds.
export default {
  name: 'vote_media',
  async execute(interaction, client, [index] = [], dependencies = {}) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const vote = await loadVote(client, interaction.guildId, interaction.message.id);
    const position = Number(index);
    const picture = vote ? votePicture(vote, position) : null;
    if (!picture) {
      const reply = await interaction.editReply({ embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'This picture is no longer available.'), CLOUDY_RED_COLOR)] });
      const timer = setTimeout(() => { void interaction.deleteReply(reply).catch(() => {}); }, 10_000);
      timer.unref?.();
      return;
    }
    const file = await pictureFile(client, vote, position, picture, dependencies.fetchImpl || fetch);
    // The option's name and its picture (owner's choice: no title, no logo).
    const option = vote.options?.[position];
    const reply = await interaction.editReply({
      embeds: [{
        ...(option ? { description: `**${option}**` } : {}),
        image: { url: file ? `attachment://${file.name}` : picture }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER },
      }],
      ...(file ? { files: [file] } : {}),
    });
    const key = `vote-media:${interaction.id}`;
    const remove = () => interaction.deleteReply(reply).catch(() => {});
    const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, PICTURE_LIFETIME_MS);
    timer.unref?.();
    // A restart removes it at once instead of leaving it behind.
    registerPendingDelete(key, remove);
  },
};
