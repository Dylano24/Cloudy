import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder, parseEmoji } from 'discord.js';
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
export const PICK_ID = 'vote_pick';
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});

const notAvailable = () => ({
  payload: {
    embeds: [setPreservedEmbedColor(warningEmbed('Warning', 'This picture is no longer available.'), CLOUDY_RED_COLOR)],
    components: [],
    attachments: [],
  },
  lifetime: NOTICE_MS,
});

// The options of a vote that have a picture.
const withPicture = vote => vote.options.map((_, index) => index)
  .filter(index => (vote.pictureOptions ? vote.pictureOptions[index] : votePicture(vote, index)));

/** The dropdown (owner's choice): the choices with a picture; the chosen one stays selected. */
export function pictureMenu(vote, key, chosen = null) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PICK_ID}:${vote.messageId}:${key}`)
    // The owner's name for it.
    .setPlaceholder('Choices preview')
    .addOptions(withPicture(vote).map(index => {
      const emoji = parseEmoji(voteNumberIcon(index));
      return {
        label: vote.options[index].slice(0, 100),
        value: String(index),
        ...(emoji?.name ? { emoji } : {}),
        ...(index === chosen ? { default: true } : {}),
      };
    }));
  return new ActionRowBuilder().addComponents(menu);
}

async function pictureOf(client, vote, position, fetchImpl, shrink) {
  const url = votePicture(vote, position);
  // The small copy (votePreviewService.js), made when the vote was posted.
  const file = await votePreviewFile({
    messageId: vote.messageId, position, url, fetchImpl, shrink,
    // Discord's picture link may have expired: ask for a fresh one.
    refresh: vote.optionMedia ? async () => (await freshVotePictureLinks(client, vote.optionMedia))?.[position] : null,
  });
  return file || url ? { position, file, url } : null;
}

// The picture with its number and the option's name and the Cloudy footer
// (owner's choice: no title, no logo). A footer of its own keeps Cloudy's
// automatic logo away: that is only added to embeds without a footer.
// A picture chosen in the dropdown has no name above it (owner's choice): the
// dropdown under it already shows the choice.
function pictureEmbed(vote, { position, file, url }, { withName = true } = {}) {
  return {
    ...(withName ? { description: `${voteNumberIcon(position)} **${vote.options[position]}**` } : {}),
    image: { url: file ? `attachment://${file.name}` : url },
    color: 0xFFFFFF,
    footer: { text: CLOUDY_FOOTER },
  };
}

async function previewAnswer(client, interaction, which, fetchImpl, shrink) {
  const vote = await loadVote(client, interaction.guildId, interaction.message.id);
  if (!vote) return notAvailable();
  // The one Preview beside the choices opens the dropdown (owner's choice).
  if (which === 'all') {
    if (!withPicture(vote).length) return notAvailable();
    return { payload: { components: [pictureMenu(vote, interaction.id)] }, lifetime: PICTURE_LIFETIME_MS };
  }
  // Older votes: the Preview button of one option shows that picture.
  const picture = await pictureOf(client, vote, Number(which), fetchImpl, shrink);
  if (!picture) return notAvailable();
  return {
    payload: { embeds: [pictureEmbed(vote, picture)], files: picture.file ? [picture.file] : [] },
    lifetime: PICTURE_LIFETIME_MS,
  };
}

// The private message disappears 30 seconds after its last use; a restart
// removes it at once instead of leaving it behind.
const removals = new Map();
function removeLater(key, interaction, lifetime) {
  const name = `vote-media:${key}`;
  clearTimeout(removals.get(name));
  const remove = () => interaction.deleteReply().catch(() => {});
  const timer = setTimeout(() => {
    removals.delete(name);
    unregisterPendingDelete(name);
    void remove();
  }, lifetime);
  timer.unref?.();
  removals.set(name, timer);
  registerPendingDelete(name, remove);
}

/** vote_pick:<vote message>:<preview>: the dropdown shows the chosen picture in the same private message. */
export async function pickVotePicture(interaction, client, [messageId, key] = [], dependencies = {}) {
  const preparing = (async () => {
    const vote = await loadVote(client, interaction.guildId, messageId);
    const position = Number(interaction.values?.[0]);
    const picture = vote && withPicture(vote).includes(position)
      ? await pictureOf(client, vote, position, dependencies.fetchImpl || fetch, dependencies.shrink || shrinkVotePicture)
      : null;
    if (!picture) return notAvailable();
    return {
      payload: {
        embeds: [pictureEmbed(vote, picture, { withName: false })],
        files: picture.file ? [picture.file] : [],
        // Only the chosen picture: the one shown before is replaced.
        attachments: [],
        components: [pictureMenu(vote, key, position)],
      },
      lifetime: PICTURE_LIFETIME_MS,
    };
  })();
  // One step when ready within 2 seconds, as Preview itself.
  let answer = await Promise.race([preparing, wait(ANSWER_WITHIN_MS)]);
  if (answer) {
    await interaction.update(answer.payload);
  } else {
    await interaction.deferUpdate();
    answer = await preparing;
    await interaction.editReply(answer.payload);
  }
  removeLater(key || interaction.message?.id, interaction, answer.lifetime);
}

// vote_media:all: the Preview button beside the choices. It opens a private
// dropdown of the choices with a picture (owner's choice); choosing one shows
// that picture (vote_pick). vote_media:<option index> (older votes) shows that
// option's picture at once. The answer is prepared first and sent in one step
// (a "thinking" reply filled in afterwards made the vote flicker); only when
// preparing takes longer than 2 seconds is the click acknowledged first.
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
    removeLater(interaction.id, interaction, answer.lifetime);
  },
};
