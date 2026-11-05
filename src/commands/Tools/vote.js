import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { warningEmbed } from '../../utils/embeds.js';
import { parseDuration } from '../../services/giveawayService.js';
import { MAX_VOTE_OPTIONS, buildVoteMessage, downloadVotePicture, saveVote } from '../../services/voteService.js';

const MAX_PICTURES = 4;

const NAMES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

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
  data: (() => {
    const command = new SlashCommandBuilder()
      .setName('vote')
      .setDescription('Start a vote with up to 10 options.')
      .addStringOption(option => option.setName('question').setDescription('What people vote on').setRequired(true).setMaxLength(250));
    for (let index = 0; index < MAX_VOTE_OPTIONS; index += 1) {
      command.addStringOption(option => option
        .setName(`option${index + 1}`)
        .setDescription(`${NAMES[index]} option${index < 2 ? '' : ' (optional)'}`)
        .setRequired(index < 2)
        .setMaxLength(80));
    }
    command.addStringOption(option => option
      .setName('duration')
      .setDescription('How long the vote stays open, e.g. 1h or 2d (optional)')
      .setRequired(false)
      .setMaxLength(10));
    // Pictures (e.g. a map per option): shown small side by side in the vote,
    // a click opens one in full size (owner's choice).
    for (let index = 1; index <= MAX_PICTURES; index += 1) {
      command.addAttachmentOption(option => option
        .setName(`picture${index}`)
        .setDescription(`Picture for option ${index}, e.g. its map (optional)`)
        .setRequired(false));
    }
    return command;
  })(),

  async execute(interaction, dependencies = {}) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const warn = text => notice(interaction, setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR));
    if (!interaction.inGuild?.() || !interaction.channel?.send) return warn('Votes only work in a server channel.');
    const question = interaction.options.getString('question').trim();
    const options = [];
    for (let index = 1; index <= MAX_VOTE_OPTIONS; index += 1) {
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
    const pictures = [];
    for (let index = 1; index <= MAX_PICTURES; index += 1) {
      const attachment = interaction.options.getAttachment?.(`picture${index}`);
      if (!attachment) continue;
      if (index > options.length) return warn(`Picture ${index} has no option ${index}.`);
      try {
        pictures.push(await downloadVotePicture(attachment, index, dependencies.fetchImpl));
      } catch (error) {
        return warn(error?.message || `Picture ${index} could not be added.`);
      }
    }
    const vote = {
      messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
      question, options, votes: {}, endsAt, ended: false,
      ...(pictures.length ? { images: pictures.map(picture => picture.image) } : {}),
      createdBy: interaction.user.id, createdAt: new Date().toISOString(),
    };
    const files = pictures.map(picture => picture.file);
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
