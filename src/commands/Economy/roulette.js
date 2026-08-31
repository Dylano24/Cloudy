import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';

export default {
  data: new SlashCommandBuilder().setName('roulette').setDescription('Play European roulette')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1))
    .addStringOption(option => option.setName('bet').setDescription('Choose red, black, even, odd, or a number 0–36').setRequired(true)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;
    const choice = interaction.options.getString('bet').trim().toLowerCase();
    if (!['red', 'black', 'even', 'odd'].includes(choice) && !/^(?:[0-9]|[12][0-9]|3[0-6])$/.test(choice)) {
      throw createError('Invalid roulette bet', ErrorTypes.VALIDATION, 'Choose `red`, `black`, `even`, `odd`, or a number from 0 to 36.');
    }
    const { amount, userData } = await takeBet(interaction, client);
    const number = Math.floor(Math.random() * 37);
    const red = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    const color = number === 0 ? 'green' : red.has(number) ? 'red' : 'black';
    const won = /^\d+$/.test(choice) ? Number(choice) === number : choice === color || (number !== 0 && choice === (number % 2 ? 'odd' : 'even'));
    const multiplier = /^\d+$/.test(choice) ? 36 : won ? 2 : 0;
    const result = await settleBet(interaction, client, userData, amount, multiplier);
    const embed = (won ? successEmbed : warningEmbed)(won ? 'Roulette — You won!' : 'Roulette — You lost',
      `The wheel landed on **${number} ${color}**.\n${won ? `You received **${money(result.payout)}**.` : `You lost **${money(amount)}**.`}`)
      .addFields({ name: 'Cash balance', value: money(result.balance), inline: true });
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
  }, { command: 'roulette' }),
};
