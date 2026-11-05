import { MessageFlags, SlashCommandBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { warningEmbed } from '../../utils/embeds.js';
import { parseDuration } from '../../services/giveawayService.js';
import { CLOUDY_FOOTER, buildVoteMessage, saveVote } from '../../services/voteService.js';
import { storeEmbedMediaBuffer } from '../../services/embedMediaStorageService.js';

const VOTE_OPTIONS = 3;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

// Short replies disappear after exactly 10 seconds.
function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

async function notice(interaction, embed) {
  await interaction.editReply({ embeds: [embed], components: [] });
  removeAfterTenSeconds(interaction);
}

// One message per picture (only the picture and the Cloudy footer: no title,
// no logo) in a thread on the vote. Returns the message link per option.
async function postOptionPictures(message, optionImages) {
  const links = optionImages.map(() => null);
  let thread;
  try {
    thread = await message.startThread({ name: 'Vote media', autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
  } catch {
    return links;
  }
  for (const [index, image] of optionImages.entries()) {
    if (!image) continue;
    const sent = await thread.send({
      embeds: [{ image: { url: image }, color: 0xFFFFFF, footer: { text: CLOUDY_FOOTER } }],
      allowedMentions: { parse: [] },
    }).catch(() => null);
    if (sent?.url) links[index] = sent.url;
  }
  // Only Cloudy posts there.
  await thread.setLocked?.(true).catch(() => {});
  return links;
}

// /vote (owner's choice, was /poll): a vote with buttons and live counts.
export default {
  // Only what the owner wants (owner's choice): the question, three options,
  // each followed by an optional picture (the option becomes a link to it, e.g.
  // the map), and a duration. Discord lists required options first, so only
  // the question and option 1 are required there; a second option is checked below.
  data: (() => {
    const command = new SlashCommandBuilder()
      .setName('vote')
      .setDescription('Start a vote with up to 3 options.')
      .addStringOption(option => option.setName('question').setDescription('What people vote on').setRequired(true).setMaxLength(250))
      .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true).setMaxLength(80))
      .addAttachmentOption(option => option.setName('media1').setDescription('Picture for option 1, e.g. its map: the option becomes a link (optional)').setRequired(false));
    for (const index of [2, 3]) {
      command
        .addStringOption(option => option.setName(`option${index}`).setDescription(index === 2 ? 'Second option' : 'Third option (optional)').setRequired(false).setMaxLength(80))
        .addAttachmentOption(option => option.setName(`media${index}`).setDescription(`Picture for option ${index}, e.g. its map: the option becomes a link (optional)`).setRequired(false));
    }
    return command.addStringOption(option => option.setName('duration').setDescription('How long the vote stays open, e.g. 1h or 2d (optional)').setRequired(false).setMaxLength(10));
  })(),

  async execute(interaction, dependencies = {}) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const warn = text => notice(interaction, setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR));
    if (!interaction.inGuild?.() || !interaction.channel?.send) return warn('Votes only work in a server channel.');
    const question = interaction.options.getString('question').trim();
    const options = [];
    const media = [];
    for (let index = 1; index <= VOTE_OPTIONS; index += 1) {
      const option = interaction.options.getString(`option${index}`)?.trim();
      const picture = interaction.options.getAttachment?.(`media${index}`) || null;
      if (picture && !option) return warn(`Media ${index} has no option ${index}.`);
      if (option) { options.push(option); media.push(picture); }
    }
    if (options.length < 2) return warn('Add at least two options.');
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
      return warn('Every option must be different.');
    }
    let endsAt = null;
    const duration = interaction.options.getString('duration')?.trim();
    if (duration) {
      try {
        endsAt = Date.now() + parseDuration(duration);
      } catch (error) {
        return warn(error?.userMessage || 'Use a duration like 30m, 1h or 2d.');
      }
    }
    // Each picture is stored as permanent Cloudy media. After the vote is
    // posted, every picture gets its own message in a "Vote media" thread on
    // the vote, and that option becomes a blue link to its message (inside
    // Discord, never a website). Options without a picture stay plain text.
    const store = dependencies.storeMedia || storeEmbedMediaBuffer;
    const fetchImpl = dependencies.fetchImpl || fetch;
    const optionImages = [];
    for (const [index, picture] of media.entries()) {
      if (!picture) { optionImages.push(null); continue; }
      try {
        if (!String(picture.contentType || '').startsWith('image/')) throw new Error(`Media ${index + 1} must be a picture.`);
        if (picture.size > MAX_MEDIA_BYTES) throw new Error(`Media ${index + 1} is larger than 10 MB.`);
        const response = await fetchImpl(picture.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Media ${index + 1} could not be downloaded.`);
        const url = await store(Buffer.from(await response.arrayBuffer()));
        if (!url) throw new Error('Media cannot be stored right now.');
        optionImages.push(url);
      } catch (error) {
        return warn(error?.message || `Media ${index + 1} could not be added.`);
      }
    }
    const vote = {
      messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
      question, options, votes: {}, endsAt, ended: false,
      ...(optionImages.some(Boolean) ? { optionImages } : {}),
      createdBy: interaction.user.id, createdAt: new Date().toISOString(),
    };
    const message = await interaction.channel.send(buildVoteMessage(vote));
    vote.messageId = message.id;
    if (optionImages.some(Boolean)) {
      vote.optionLinks = await postOptionPictures(message, optionImages);
      if (vote.optionLinks.some(Boolean)) await message.edit(buildVoteMessage(vote)).catch(() => {});
    }
    try {
      await saveVote(interaction.client, interaction.guildId, vote);
    } catch (error) {
      await message.delete().catch(() => {});
      throw error;
    }
    return notice(interaction, successEmbed('Success', 'The vote is live.'));
  },
};
