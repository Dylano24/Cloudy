import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  createOwnerAssistantHandoff,
  getOwnerAssistantCooldown,
} from '../services/ownerAssistantService.js';
import { hasCloudyOwnerRole } from '../services/ownerRoleAccess.js';
import {
  FIX_GUIDE_ASK_BUTTON_ID,
  FIX_GUIDE_ASK_MODAL_ID,
  FIX_GUIDE_CHANNEL_ID,
  FIX_GUIDE_QUESTION_INPUT_ID,
} from './cloudyOwnerAssistantReady.js';
import { logger } from '../utils/logger.js';

const MAX_QUESTION_LENGTH = 4000;
const EMBED_CHUNK_SIZE = 3900;

function splitText(value, maxLength = EMBED_CHUNK_SIZE) {
  const text = String(value || '').trim();
  if (!text) return [];
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildAnswerEmbeds(interaction, result) {
  const chunks = splitText(result.text);
  return chunks.slice(0, 3).map((chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setTitle(index === 0 ? 'Cloudy Fix Guide' : `Cloudy Fix Guide • ${index + 1}`)
      .setDescription(chunk);

    if (index === chunks.length - 1 || index === 2) {
      const diagnostics = result.diagnostics || {};
      const footer = [
        `Owner: ${interaction.user.username}`,
        `Channels: ${diagnostics.readableChannelsScanned || 0}`,
        `Evidence: ${diagnostics.evidenceItems || 0}`,
        `Code files: ${diagnostics.githubFilesRead || 0}`,
        `Logs: ${diagnostics.runtimeLogLines || 0}`,
        diagnostics.webEnabled ? 'Live web: Yes' : 'Live web: No',
      ].join(' • ');
      embed.setFooter({ text: footer.slice(0, 2048) });
    }

    return embed;
  });
}

function buildQuestionModal() {
  const question = new TextInputBuilder()
    .setCustomId(FIX_GUIDE_QUESTION_INPUT_ID)
    .setLabel('What do you want Cloudy to investigate?')
    .setPlaceholder('Describe the problem, question or task in as much detail as you want...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(MAX_QUESTION_LENGTH)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(FIX_GUIDE_ASK_MODAL_ID)
    .setTitle('Ask Cloudy')
    .addComponents(new ActionRowBuilder().addComponents(question));
}

async function denyNonOwner(interaction) {
  const payload = {
    content: 'This Fix Guide is available to members with the Owner role only.',
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

export default {
  name: Events.InteractionCreate,

  async execute(interaction) {
    const isAskButton = interaction.isButton?.() && interaction.customId === FIX_GUIDE_ASK_BUTTON_ID;
    const isAskModal = interaction.isModalSubmit?.() && interaction.customId === FIX_GUIDE_ASK_MODAL_ID;
    if (!isAskButton && !isAskModal) return;
    if (!interaction.guild || String(interaction.channelId || '') !== FIX_GUIDE_CHANNEL_ID) return;

    if (!hasCloudyOwnerRole(interaction)) {
      await denyNonOwner(interaction);
      return;
    }

    if (isAskButton) {
      await interaction.showModal(buildQuestionModal()).catch(error => {
        logger.error('[OWNER_ASSISTANT] Failed to open FIX-GUIDE Ask modal:', error);
      });
      return;
    }

    const question = String(
      interaction.fields.getTextInputValue(FIX_GUIDE_QUESTION_INPUT_ID) || '',
    ).trim().slice(0, MAX_QUESTION_LENGTH);
    if (question.length < 3) return;

    const cooldown = getOwnerAssistantCooldown(interaction.user.id);
    if (cooldown > 0) {
      const seconds = Math.max(1, Math.ceil(cooldown / 1000));
      await interaction.reply({
        content: `Cloudy is still processing requests. Try again in ${seconds}s.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await interaction.reply({
      content: 'Cloudy is investigating this now…',
      flags: MessageFlags.Ephemeral,
    });

    try {
      const result = await createOwnerAssistantHandoff(
        interaction.client,
        interaction.guild,
        question,
      );
      const embeds = buildAnswerEmbeds(interaction, result);
      if (!embeds.length) throw new Error('Fix Guide generated an empty response.');

      await interaction.editReply({ content: null, embeds: [embeds[0]] });
      for (const embed of embeds.slice(1)) {
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      logger.info(
        `[OWNER_ASSISTANT] mode=fix-guide owner=${interaction.user.id} guild=${interaction.guild.id} `
        + `channel=${interaction.channelId} evidence=${result.diagnostics?.evidenceItems || 0} `
        + `model=${result.diagnostics?.model || 'unknown'} provider=${result.diagnostics?.provider || 'unknown'}`,
      );
    } catch (error) {
      logger.error('[OWNER_ASSISTANT] FIX-GUIDE request failed:', error);
      const payload = {
        content: /local_rate_budget|rate_limit|429/.test(error.message)
          ? 'Cloudy is temporarily at capacity. Please try again in about one minute.'
          : 'Cloudy is temporarily unavailable. Please try again shortly. Your request did not change any server data.',
        embeds: [],
      };
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};
