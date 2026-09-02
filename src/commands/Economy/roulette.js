import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';
import { getRouletteColor, rouletteNumberEmoji } from './modules/rouletteNumberEmoji.js';

export default {
  data: new SlashCommandBuilder().setName('roulette').setDescription('Play European roulette')
    .addIntegerOption(option => option
      .setName('amount')
      .setDescription('Bet any cash amount you can afford')
      .setRequired(true)
      .setMinValue(1))
    .addStringOption(option => option
      .setName('bet')
      .setDescription('Choose red, black, even, odd, or a number 0–36')
      .setRequired(true)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const choice = interaction.options.getString('bet').trim().toLowerCase();
    if (!['red', 'black', 'even', 'odd'].includes(choice) && !/^(?:[0-9]|[12][0-9]|3[0-6])$/.test(choice)) {
      throw createError(
        'Invalid roulette bet',
        ErrorTypes.VALIDATION,
        'Choose `red`, `black`, `even`, `odd`, or a number from 0 to 36.',
      );
    }

    const { amount, userData } = await takeBet(interaction, client);
    const number = Math.floor(Math.random() * 37);
    const color = getRouletteColor(number);
    const tile = await rouletteNumberEmoji(client, number);
    const numberBet = /^\d+$/.test(choice);
    const won = numberBet
      ? Number(choice) === number
      : choice === color || (number !== 0 && choice === (number % 2 ? 'odd' : 'even'));
    const multiplier = numberBet ? (won ? 36 : 0) : (won ? 2 : 0);
    const result = await settleBet(interaction, client, userData, amount, multiplier);

    const embed = createEmbed({
      title: won ? 'Roulette win' : 'Roulette loss',
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

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
  }, { command: 'roulette' }),
};
