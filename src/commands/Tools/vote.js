import { FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { warningEmbed } from '../../utils/embeds.js';
import { parseDuration } from '../../services/giveawayService.js';
import { buildVoteMessage, saveVote } from '../../services/voteService.js';
import { uploadVotePictures } from '../../services/voteMediaService.js';
import { warmVotePreviews } from '../../services/votePreviewService.js';
import { logger } from '../../utils/logger.js';

const VOTE_OPTIONS = 3;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const VOTE_FORM_ID = 'vote_media_form';
const FORM_TTL_MS = 30 * 60_000;
// A vote waits here while its media form is open.
const drafts = new Map();

// Short replies disappear after exactly 10 seconds.
function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

async function notice(interaction, embed) {
  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed], components: [] });
  else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  removeAfterTenSeconds(interaction);
}

const warn = (interaction, text) => notice(interaction, setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR));

/** The optional media step (owner's choice): one picture field per option; all may stay empty. */
export function voteMediaForm(id, options) {
  return new ModalBuilder()
    .setCustomId(`${VOTE_FORM_ID}:${id}`)
    .setTitle('Add media')
    .addLabelComponents(...options.map((option, index) => new LabelBuilder()
      .setLabel(`${index + 1}. ${option}`.slice(0, 45))
      .setDescription('Optional: a picture for this option, e.g. its map.')
      .setFileUploadComponent(new FileUploadBuilder()
        .setCustomId(`media${index + 1}`)
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1))));
}

function uploadedPicture(interaction, index) {
  try {
    return interaction.fields.getUploadedFiles(`media${index + 1}`)?.first?.() || null;
  } catch {
    return null;
  }
}

/** The media form was sent: post the vote, with the pictures that were added or without any. */
export async function submitVoteForm(interaction, id, dependencies = {}) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = drafts.get(id);
  drafts.delete(id);
  if (!draft || draft.expiresAt <= Date.now() || draft.userId !== interaction.user.id) {
    return warn(interaction, 'This vote form has expired. Use /vote again.');
  }
  if (!interaction.inGuild?.() || !interaction.channel?.send) return warn(interaction, 'Votes only work in a server channel.');
  // Pictures (owner's choice): uploaded to Discord, each option with a
  // picture becomes a blue link that opens it (voteMediaService.js).
  const fetchImpl = dependencies.fetchImpl || fetch;
  const files = [];
  for (const index of draft.options.keys()) {
    const picture = uploadedPicture(interaction, index);
    if (!picture) { files.push(null); continue; }
    try {
      const type = String(picture.contentType || '');
      if (!type.startsWith('image/')) throw new Error(`Media ${index + 1} must be a picture.`);
      if (picture.size > MAX_MEDIA_BYTES) throw new Error(`Media ${index + 1} is larger than 10 MB.`);
      const response = await fetchImpl(picture.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Media ${index + 1} could not be downloaded.`);
      const extension = EXTENSIONS[type.split(';')[0]]
        || String(picture.name || '').match(/\.(png|jpe?g|gif|webp|heic|heif)$/i)?.[1]?.toLowerCase() || 'png';
      files.push({ attachment: Buffer.from(await response.arrayBuffer()), name: `option${index + 1}.${extension}` });
    } catch (error) {
      return warn(interaction, error?.message || `Media ${index + 1} could not be added.`);
    }
  }
  let pictures = null;
  if (files.some(Boolean)) {
    try {
      pictures = await (dependencies.uploadPictures || uploadVotePictures)(interaction.client, interaction.guild, interaction.channel, files);
    } catch (error) {
      return warn(interaction, error?.message || 'The pictures could not be added.');
    }
  }
  const vote = {
    messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
    question: draft.question, options: draft.options, votes: {},
    endsAt: draft.durationMs ? Date.now() + draft.durationMs : null, ended: false,
    // With pictures: a Preview button next to each option with a picture.
    ...(pictures ? { optionLinks: pictures.links, optionMedia: pictures.media, mediaRefreshedAt: Date.now(), layout: 'preview' } : {}),
    createdBy: interaction.user.id, createdAt: new Date().toISOString(),
  };
  let message;
  try {
    message = await interaction.channel.send(buildVoteMessage(vote));
  } catch (error) {
    if (!vote.layout) throw error;
    // Never lose the vote: the normal layout (blue links) if Discord refuses the card.
    logger.warn(`[VOTE] Preview layout refused, normal layout used: ${error?.message || error}`);
    delete vote.layout;
    message = await interaction.channel.send(buildVoteMessage(vote));
  }
  vote.messageId = message.id;
  try {
    await saveVote(interaction.client, interaction.guildId, vote);
  } catch (error) {
    await message.delete().catch(() => {});
    throw error;
  }
  // The small Preview copies are made now, so the first Preview is instant too.
  if (pictures) void (dependencies.warmPreviews || warmVotePreviews)(message.id, files).catch(() => {});
  return notice(interaction, successEmbed('Success', 'The vote is live.'));
}

// /vote (owner's choice, was /poll): a vote with buttons and live counts.
export default {
  // Only what the owner wants (owner's choice): the question, three options and
  // a duration. Media is a separate, optional step: after sending, a form asks
  // for a picture per option (e.g. its map); leave it empty for none.
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Start a vote with up to 3 options.')
    .addStringOption(option => option.setName('question').setDescription('What people vote on').setRequired(true).setMaxLength(250))
    .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true).setMaxLength(80))
    .addStringOption(option => option.setName('option2').setDescription('Second option').setRequired(true).setMaxLength(80))
    .addStringOption(option => option.setName('option3').setDescription('Third option (optional)').setRequired(false).setMaxLength(80))
    .addStringOption(option => option.setName('duration').setDescription('How long the vote stays open, e.g. 1h or 2d (optional)').setRequired(false).setMaxLength(10)),

  async execute(interaction) {
    if (!interaction.inGuild?.() || !interaction.channel?.send) return warn(interaction, 'Votes only work in a server channel.');
    const question = interaction.options.getString('question').trim();
    const options = [];
    for (let index = 1; index <= VOTE_OPTIONS; index += 1) {
      const option = interaction.options.getString(`option${index}`)?.trim();
      if (option) options.push(option);
    }
    if (options.length < 2) return warn(interaction, 'Add at least two options.');
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
      return warn(interaction, 'Every option must be different.');
    }
    let durationMs = null;
    const duration = interaction.options.getString('duration')?.trim();
    if (duration) {
      try {
        durationMs = parseDuration(duration);
      } catch (error) {
        return warn(interaction, error?.userMessage || 'Use a duration like 30m, 1h or 2d.');
      }
    }
    const now = Date.now();
    for (const [key, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(key);
    drafts.set(interaction.id, { question, options, durationMs, userId: interaction.user.id, expiresAt: now + FORM_TTL_MS });
    return interaction.showModal(voteMediaForm(interaction.id, options));
  },
};
