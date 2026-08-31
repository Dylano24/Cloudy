import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed, infoEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';

const card = () => Math.floor(Math.random() * 13) + 1;
const value = cards => { let total = cards.reduce((n, c) => n + (c === 1 ? 11 : Math.min(c, 10)), 0); let aces = cards.filter(c => c === 1).length; while (total > 21 && aces--) total -= 10; return total; };
const label = c => c === 1 ? 'A' : c === 11 ? 'J' : c === 12 ? 'Q' : c === 13 ? 'K' : String(c);

export default {
  data: new SlashCommandBuilder().setName('blackjack').setDescription('Play a quick blackjack hand')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction); if (!deferred) return;
    const { amount, userData } = await takeBet(interaction, client);
    const player = [card(), card()], dealer = [card(), card()];
    while (value(player) < 17) player.push(card());
    while (value(dealer) < 17) dealer.push(card());
    const p = value(player), d = value(dealer);
    const outcome = p > 21 ? 'loss' : d > 21 || p > d ? 'win' : p === d ? 'push' : 'loss';
    const result = await settleBet(interaction, client, userData, amount, outcome === 'win' ? (p === 21 && player.length === 2 ? 2.5 : 2) : outcome === 'push' ? 1 : 0);
    const embedFactory = outcome === 'win' ? successEmbed : outcome === 'push' ? infoEmbed : warningEmbed;
    const text = outcome === 'win' ? `You received **${money(result.payout)}**.` : outcome === 'push' ? `Push — your **${money(amount)}** bet was returned.` : `You lost **${money(amount)}**.`;
    const embed = embedFactory(outcome === 'win' ? 'Blackjack — You won!' : outcome === 'push' ? 'Blackjack — Push' : 'Blackjack — You lost', `Your hand: **${player.map(label).join(', ')}** (${p})\nDealer: **${dealer.map(label).join(', ')}** (${d})\n\n${text}`)
      .addFields({ name: 'Cash balance', value: money(result.balance), inline: true });
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
  }, { command: 'blackjack' }),
};
