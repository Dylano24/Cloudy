import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { decorateEmbedWithSavedTemplate } from '../../services/embedTemplateService.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';
import { getRouletteColor, rouletteNumberEmoji } from './modules/rouletteNumberEmoji.js';

const ROULETTE_BETS = new Set(['red', 'black', 'even', 'odd', 'number']);
const NUMBER_MODAL_TIMEOUT = 60_000;

async function styledReply(interaction, sourceInteraction, embed, options = {}) {
  const guildId = sourceInteraction.guildId || interaction.guildId;
  const channelId = sourceInteraction.channelId || interaction.channelId;
  const styled = guildId && channelId
    ? await decorateEmbedWithSavedTemplate(guildId, channelId, embed)
    : { embed };

  return InteractionHelper.safeReply(interaction, {
    embeds: [styled.embed],
    components: [],
    ...options,
  });
}

async function requestRouletteNumber(interaction) {
  // Keep this custom id colon-free. Inline-awaited modals with a colon are also
  // routed through the global modal registry, which would produce the unrelated
  // "This form is not available" configuration error before this waiter finishes.
  const customId = `roulette_number_${interaction.id}`;
  const input = new TextInputBuilder()
    .setCustomId('roulette_number_value')
    .setLabel('Choose a number from 0 to 36')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0 - 36')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2);

  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Roulette — Choose a number')
    .addComponents(new ActionRowBuilder().addComponents(input));

  const shown = await InteractionHelper.safeShowModal(interaction, modal);
  if (!shown) return null;

  const submitted = await interaction.awaitModalSubmit({
    time: NUMBER_MODAL_TIMEOUT,
    filter: modalInteraction =>
      modalInteraction.customId === customId
      && modalInteraction.user.id === interaction.user.id,
  }).catch(() => null);

  if (!submitted) return null;

  const raw = submitted.fields.getTextInputValue('roulette_number_value').trim();
  const value = Number(raw);
  const valid = /^\d{1,2}$/.test(raw)
    && Number.isInteger(value)
    && value >= 0
    && value <= 36;

  if (!valid) {
    const embed = createEmbed({
      title: 'Invalid Input',
      description: 'Choose a whole number from **0 to 36**.',
      color: 'error',
    });
    await styledReply(submitted, interaction, embed, { flags: MessageFlags.Ephemeral });
    return null;
  }

  return { number: value, responseInteraction: submitted };
}

async function replyModalGameError(responseInteraction, sourceInteraction, error) {
  const title = error?.type === ErrorTypes.VALIDATION ? 'Invalid Input' : 'Something Went Wrong';
  const embed = createEmbed({
    title,
    description: error?.userMessage || 'Something went wrong. Please try again.',
    color: 'error',
  });
  await styledReply(responseInteraction, sourceInteraction, embed, { flags: MessageFlags.Ephemeral });
}

export default {
  data: new SlashCommandBuilder().setName('roulette').setDescription('Play European roulette')
    .addIntegerOption(option => option
      .setName('amount')
      .setDescription('Bet any cash amount you can afford')
      .setRequired(true)
      .setMinValue(1))
    .addStringOption(option => option
      .setName('bet')
      .setDescription('Choose your roulette bet')
      .setRequired(true)
      .addChoices(
        { name: 'Red', value: 'red' },
        { name: 'Black', value: 'black' },
        { name: 'Even', value: 'even' },
        { name: 'Odd', value: 'odd' },
        { name: 'Number', value: 'number' },
      ))
    .addIntegerOption(option => option
      .setName('number')
      .setDescription('Optional: choose 0-36 now, or enter it after selecting Number')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(36)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const selectedBet = interaction.options.getString('bet', true).trim().toLowerCase();
    let selectedNumber = interaction.options.getInteger('number');
    let responseInteraction = interaction;

    if (!ROULETTE_BETS.has(selectedBet)) {
      throw createError(
        'Invalid roulette bet',
        ErrorTypes.VALIDATION,
        'Choose `red`, `black`, `even`, `odd`, or `number`.',
      );
    }

    // Discord slash-command options cannot become required conditionally. If the
    // player chooses Number without filling the optional number field, open a
    // modal immediately instead of returning an Invalid Input embed.
    if (selectedBet === 'number' && selectedNumber === null) {
      const selection = await requestRouletteNumber(interaction);
      if (!selection) return;
      selectedNumber = selection.number;
      responseInteraction = selection.responseInteraction;
    }

    const deferred = await InteractionHelper.safeDefer(responseInteraction);
    if (!deferred) return;

    try {
      const choice = selectedBet === 'number' ? String(selectedNumber) : selectedBet;
      const { amount, userData } = await takeBet(interaction, client);
      const number = Math.floor(Math.random() * 37);
      const color = getRouletteColor(number);
      const tile = await rouletteNumberEmoji(client, number);
      const numberBet = selectedBet === 'number';
      const won = numberBet
        ? selectedNumber === number
        : choice === color || (number !== 0 && choice === (number % 2 ? 'odd' : 'even'));
      const multiplier = numberBet ? (won ? 36 : 0) : (won ? 2 : 0);
      const result = await settleBet(interaction, client, userData, amount, multiplier);

      const embed = createEmbed({
        title: won ? 'Roulette — You won!' : 'Roulette — You lost',
        description: `The wheel landed on ${tile}\n**${number} • ${color.charAt(0).toUpperCase() + color.slice(1)}**`,
        color: won ? 'success' : 'warning',
        fields: [
          { name: 'Your bet', value: `**${money(amount)}** on **${choice}**`, inline: true },
          {
            name: won ? 'Payout' : 'Result',
            value: won ? `**${money(result.payout)}**` : `Lost **${money(amount)}**`,
            inline: true,
          },
          { name: 'Cash balance', value: `**${money(result.balance)}**`, inline: true },
        ],
      });

      const styled = interaction.guildId && interaction.channelId
        ? await decorateEmbedWithSavedTemplate(interaction.guildId, interaction.channelId, embed)
        : { embed };

      await InteractionHelper.safeEditReply(responseInteraction, { embeds: [styled.embed], components: [] });
    } catch (error) {
      // Once a modal has been shown the original slash interaction is already
      // acknowledged. Route any game/economy error to the modal submission so
      // insufficient funds and validation errors are still visible to the user.
      if (responseInteraction !== interaction) {
        await replyModalGameError(responseInteraction, interaction, error);
        return;
      }
      throw error;
    }
  }, { command: 'roulette' }),
};
