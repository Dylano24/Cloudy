import { MessageFlags } from 'discord.js';
import { warningEmbed } from '../../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../../utils/embedColorPolicy.js';
import { CLOUDY_FOOTER, loadVote, votePicture } from '../../../services/voteService.js';
import { freshVotePictureLinks } from '../../../services/voteMediaService.js';
import { registerPendingDelete, unregisterPendingDelete } from '../../../utils/pendingTransientDeletes.js';

export const PICTURE_LIFETIME_MS = 30_000;
export const NOTICE_MS = 10_000;
// Discord waits 3 seconds for the answer.
export const ANSWER_WITHIN_MS = 2_000;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
// Pictures shown recently are kept for 10 minutes, so the next Preview is instant.
const KEEP_MS = 10 * 60_000;
const KEEP_MAX_BYTES = 25 * 1024 * 1024;
const kept = new Map();

const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});

function keptPicture(key) {
  const entry = kept.get(key);
  if (!entry || entry.at + KEEP_MS < Date.now()) {
    kept.delete(key);
    return null;
  }
  return entry.file;
}

function keepPicture(key, file) {
  kept.delete(key);
  kept.set(key, { file, at: Date.now() });
  let total = [...kept.values()].reduce((sum, entry) => sum + entry.file.attachment.length, 0);
  for (const [oldKey, entry] of kept) {
    if (total <= KEEP_MAX_BYTES) break;
    kept.delete(oldKey);
    total -= entry.file.attachment.length;
  }
}

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
  const key = `${vote.messageId}:${position}:${url}`;
  const known = keptPicture(key);
  if (known) return known;
  let buffer = await download(url, fetchImpl);
  if (!buffer && vote.optionMedia) {
    // Discord's picture link may have expired: ask for a fresh one.
    const fresh = (await freshVotePictureLinks(client, vote.optionMedia).catch(() => null))?.[position];
    if (fresh) buffer = await download(fresh, fetchImpl);
  }
  if (!buffer) return null;
  const extension = String(new URL(url).pathname).match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase() || 'png';
  const file = { attachment: buffer, name: `option${position + 1}.${extension}` };
  keepPicture(key, file);
  return file;
}

async function previewAnswer(client, interaction, position, fetchImpl) {
  const vote = await loadVote(client, interaction.guildId, interaction.message.id);
  const picture = vote ? votePicture(vote, position) : null;
  if (!picture) {
    return {
      payload: { embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'This picture is no longer available.'), CLOUDY_RED_COLOR)] },
      lifetime: NOTICE_MS,
    };
  }
  const file = await pictureFile(client, vote, position, picture, fetchImpl);
  // The option's name and its picture (owner's choice: no title, no logo).
  const option = vote.options?.[position];
  return {
    payload: {
      embeds: [{
        ...(option ? { description: `**${option}**` } : {}),
        image: { url: file ? `attachment://${file.name}` : picture }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER },
      }],
      ...(file ? { files: [file] } : {}),
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
    const preparing = previewAnswer(client, interaction, Number(index), dependencies.fetchImpl || fetch);
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
