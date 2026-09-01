import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';

const SYMBOLS = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
const MULTIPLIERS = { '🍒': 2, '🍋': 3, '🔔': 5, '💎': 10, '7️⃣': 25 };

export default {
  data: new SlashCommandBuilder().setName('slots').setDescription('Spin the slot machine')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;
    const { amount, userData } = await takeBet(interaction, client);
    const reels = Array.from({ length: 3 }, () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
    const multiplier = reels[0] === reels[1] && reels[1] === reels[2] ? MULTIPLIERS[reels[0]] : 0;
    const result = await settleBet(interaction, client, userData, amount, multiplier);
    const won = multiplier > 0;
    const embed = (won ? successEmbed : warningEmbed)(won ? 'Slots — You won!' : 'Slots — You lost',
      `┌─────────┐\n│ ${reels.join(' │ ')} │\n└─────────┘\n\n${won ? `Three matching symbols paid **${money(result.payout)}**.` : `You lost **${money(amount)}**.`}`)
      .addFields({ name: 'Cash balance', value: money(result.balance), inline: true });
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
  }, { command: 'slots' }),
};
