import { FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { warningEmbed } from '../../utils/embeds.js';
import { parseDuration } from '../../services/giveawayService.js';
import { buildVoteMessage, refreshVoteSoon, saveVote, setVotePictures, voteMentions, voteTag } from '../../services/voteService.js';
import { uploadVotePictures } from '../../services/voteMediaService.js';
import { keepVotePreview, shrinkVotePicture } from '../../services/votePreviewService.js';
import { logger } from '../../utils/logger.js';
import { openVoteManager } from '../../services/voteManageService.js';

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

// Discord waits 3 seconds for the answer.
export const ANSWER_WITHIN_MS = 2_000;
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});
const warning = text => setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR);

async function readPicture(interaction, index, fetchImpl) {
  const picture = uploadedPicture(interaction, index);
  if (!picture) return null;
  const type = String(picture.contentType || '');
  if (!type.startsWith('image/')) throw new Error(`Media ${index + 1} must be a picture.`);
  if (picture.size > MAX_MEDIA_BYTES) throw new Error(`Media ${index + 1} is larger than 10 MB.`);
  const response = await fetchImpl(picture.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Media ${index + 1} could not be downloaded.`);
  const extension = EXTENSIONS[type.split(';')[0]]
    || String(picture.name || '').match(/\.(png|jpe?g|gif|webp|heic|heif)$/i)?.[1]?.toLowerCase() || 'png';
  return { attachment: Buffer.from(await response.arrayBuffer()), name: `option${index + 1}.${extension}` };
}

// Posts the vote from the form and returns the notice to show. Fast (owner's
// choice, about a second): the pictures are read at the same time and made
// small (at most 1024 px wide) before anything is sent; they are stored in
// the vote-media thread in the background, after the vote is already posted.
async function postVoteFromForm(interaction, id, dependencies) {
  const draft = drafts.get(id);
  drafts.delete(id);
  if (!draft || draft.expiresAt <= Date.now() || draft.userId !== interaction.user.id) {
    return warning('This vote form has expired. Use /vote again.');
  }
  if (!interaction.inGuild?.() || !interaction.channel?.send) return warning('Votes only work in a server channel.');
  const fetchImpl = dependencies.fetchImpl || fetch;
  let files;
  try {
    files = await Promise.all(draft.options.map((_, index) => readPicture(interaction, index, fetchImpl)));
  } catch (error) {
    return warning(error?.message || 'The pictures could not be added.');
  }
  const hasPictures = files.some(Boolean);
  const shrink = dependencies.shrink || shrinkVotePicture;
  const small = hasPictures ? await Promise.all(files.map(file => (file ? shrink(file.attachment, file.name) : null))) : files;
  const upload = () => (dependencies.uploadPictures || uploadVotePictures)(interaction.client, interaction.guild, interaction.channel, small);
  const vote = {
    messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
    question: draft.question, options: draft.options, votes: {},
    ...(draft.tagRoleId ? { tagRoleId: draft.tagRoleId } : {}),
    endsAt: draft.durationMs ? Date.now() + draft.durationMs : null, ended: false,
    // Every vote is the card (owner's choice: no custom emoji, so nothing
    // flickers); a Preview button next to each option with a picture.
    layout: 'preview', pictureOptions: small.map(Boolean),
    createdBy: interaction.user.id, createdAt: new Date().toISOString(),
  };
  // The tag is its own message right above the vote (owner's choice): it is
  // never edited, so it cannot disappear when the vote is redrawn after a click.
  const tag = voteTag(vote);
  let tagMessage = null;
  if (tag) {
    tagMessage = await interaction.channel.send({ content: tag, allowedMentions: voteMentions(vote) });
    vote.tagMessageId = tagMessage.id;
  }
  let message;
  try {
    message = await interaction.channel.send(buildVoteMessage(vote));
  } catch (error) {
    // Never lose the vote: the normal layout (blue links) if Discord refuses the card.
    logger.warn(`[VOTE] Card refused, normal layout used: ${error?.message || error}`);
    delete vote.layout;
    delete vote.pictureOptions;
    if (hasPictures) {
      let pictures;
      try {
        pictures = await upload();
      } catch (uploadError) {
        await tagMessage?.delete().catch(() => {});
        return warning(uploadError?.message || 'The pictures could not be added.');
      }
      Object.assign(vote, { optionLinks: pictures.links, optionMedia: pictures.media, mediaRefreshedAt: Date.now() });
    }
    message = await interaction.channel.send(buildVoteMessage(vote));
  }
  vote.messageId = message.id;
  try {
    await saveVote(interaction.client, interaction.guildId, vote);
  } catch (error) {
    await message.delete().catch(() => {});
    await tagMessage?.delete().catch(() => {});
    throw error;
  }
  // Preview shows these small copies at once.
  small.forEach((file, position) => { if (file) keepVotePreview(message.id, position, file); });
  // One redraw 2 seconds later, so an emoji Discord's app missed is loaded again.
  (dependencies.refreshVote || refreshVoteSoon)(interaction.client, interaction.guildId, message);
  if (vote.layout === 'preview' && hasPictures) {
    void upload()
      .then(pictures => setVotePictures(interaction.client, interaction.guildId, message.id, pictures))
      .catch(error => logger.warn(`[VOTE] Vote pictures could not be stored: ${error?.message || error}`));
  }
  return successEmbed('Success', 'The vote is live.');
}

/** The media form was sent: post the vote, with the pictures that were added or without any. */
export async function submitVoteForm(interaction, id, dependencies = {}) {
  // One answer, no "thinking", when the vote is ready within 2 seconds.
  const posting = postVoteFromForm(interaction, id, dependencies);
  let embed = await Promise.race([posting, wait(ANSWER_WITHIN_MS)]);
  if (embed) {
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    embed = await posting;
    await interaction.editReply({ embeds: [embed], components: [] });
  }
  removeAfterTenSeconds(interaction);
}

// /vote (owner's choice, was /poll): a vote with buttons and live counts.
export default {
  // Only what the owner wants (owner's choice): the question, three options and
  // a duration. Media is a separate, optional step: after sending, a form asks
  // for a picture per option (e.g. its map); leave it empty for none.
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Start and manage votes.')
    .addSubcommand(command => command
      .setName('start')
      .setDescription('Start a vote with up to 3 options.')
      .addStringOption(option => option.setName('question').setDescription('What people vote on').setRequired(true).setMaxLength(250))
      .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true).setMaxLength(80))
      .addStringOption(option => option.setName('option2').setDescription('Second option').setRequired(true).setMaxLength(80))
      .addStringOption(option => option.setName('option3').setDescription('Third option (optional)').setRequired(false).setMaxLength(80))
      .addStringOption(option => option.setName('duration').setDescription('How long the vote stays open, e.g. 1h or 2d (optional)').setRequired(false).setMaxLength(10))
      .addRoleOption(option => option.setName('role').setDescription('Role to tag when the vote starts (optional)').setRequired(false)))
    .addSubcommand(command => command
      .setName('manage')
      .setDescription('Manage votes: see active and ended votes, end or delete them.')),

  async execute(interaction) {
    if (interaction.options.getSubcommand?.() === 'manage') return openVoteManager(interaction);
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
    // Tagging follows Discord's own rule: @everyone or a role that cannot be
    // mentioned needs the Mention Everyone permission.
    const role = interaction.options.getRole?.('role') || null;
    if (role && (role.id === interaction.guildId || !role.mentionable)
        && !interaction.memberPermissions?.has?.(PermissionFlagsBits.MentionEveryone)) {
      return warn(interaction, 'You cannot tag this role.');
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
    drafts.set(interaction.id, {
      question, options, tagRoleId: role?.id || null, durationMs, userId: interaction.user.id, expiresAt: now + FORM_TTL_MS,
    });
    return interaction.showModal(voteMediaForm(interaction.id, options));
  },
};
