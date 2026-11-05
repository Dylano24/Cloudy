import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { warningEmbed } from '../../utils/embeds.js';
import { parseDuration } from '../../services/giveawayService.js';
import { buildVoteMessage, downloadVoteMedia, saveVote } from '../../services/voteService.js';

const VOTE_OPTIONS = 3;

// Short replies disappear after exactly 10 seconds.
function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

async function notice(interaction, embed) {
  await interaction.editReply({ embeds: [embed], components: [] });
  removeAfterTenSeconds(interaction);
}

// /vote (owner's choice, was /poll): a vote with buttons and live counts.
export default {
  // Only what the owner wants (owner's choice): the question, three options,
  // a duration and one media file (picture or video).
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Start a vote with up to 3 options.')
    .addStringOption(option => option.setName('question').setDescription('What people vote on').setRequired(true).setMaxLength(250))
    .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true).setMaxLength(80))
    .addStringOption(option => option.setName('option2').setDescription('Second option').setRequired(true).setMaxLength(80))
    .addStringOption(option => option.setName('option3').setDescription('Third option (optional)').setRequired(false).setMaxLength(80))
    .addStringOption(option => option.setName('duration').setDescription('How long the vote stays open, e.g. 1h or 2d (optional)').setRequired(false).setMaxLength(10))
    .addAttachmentOption(option => option.setName('media').setDescription('A picture or video to show with the vote (optional)').setRequired(false)),

  async execute(interaction, dependencies = {}) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const warn = text => notice(interaction, setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR));
    if (!interaction.inGuild?.() || !interaction.channel?.send) return warn('Votes only work in a server channel.');
    const question = interaction.options.getString('question').trim();
    const options = [];
    for (let index = 1; index <= VOTE_OPTIONS; index += 1) {
      const option = interaction.options.getString(`option${index}`)?.trim();
      if (option) options.push(option);
    }
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
    let media = null;
    const attachment = interaction.options.getAttachment?.('media');
    if (attachment) {
      try {
        media = await downloadVoteMedia(attachment, dependencies.fetchImpl);
      } catch (error) {
        return warn(error?.message || 'The media could not be added.');
      }
    }
    const vote = {
      messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
      question, options, votes: {}, endsAt, ended: false,
      ...(media?.image ? { images: [media.image] } : {}),
      createdBy: interaction.user.id, createdAt: new Date().toISOString(),
    };
    const files = media ? [media.file] : [];
    const message = await interaction.channel.send({ ...buildVoteMessage(vote), ...(files.length ? { files } : {}) });
    vote.messageId = message.id;
    try {
      await saveVote(interaction.client, interaction.guildId, vote);
    } catch (error) {
      await message.delete().catch(() => {});
      throw error;
    }
    return notice(interaction, successEmbed('Success', 'The vote is live.'));
  },
};
