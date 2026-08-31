import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { takeBet, settleBet, money } from './modules/casinoGameUtils.js';

const draw = () => Math.floor(Math.random() * 13) + 1;
const score = cards => cards.reduce((total, card) => total + Math.min(card, 10), 0) % 10;
const label = card => card === 1 ? 'A' : card === 11 ? 'J' : card === 12 ? 'Q' : card === 13 ? 'K' : String(card);

export default {
  data: new SlashCommandBuilder().setName('baccarat').setDescription('Play baccarat')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1))
    .addStringOption(option => option.setName('bet').setDescription('Bet on player, banker, or tie').setRequired(true)
      .addChoices({ name: 'Player', value: 'player' }, { name: 'Banker', value: 'banker' }, { name: 'Tie', value: 'tie' })),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction); if (!deferred) return;
    const choice = interaction.options.getString('bet');
    const { amount, userData } = await takeBet(interaction, client);
    const player = [draw(), draw()]; const banker = [draw(), draw()];
    if (score(player) < 6) player.push(draw());
    if (score(banker) < 6) banker.push(draw());
    const playerScore = score(player), bankerScore = score(banker);
    const winner = playerScore === bankerScore ? 'tie' : playerScore > bankerScore ? 'player' : 'banker';
    const multiplier = choice === winner ? (winner === 'tie' ? 9 : winner === 'banker' ? 1.95 : 2) : 0;
    const result = await settleBet(interaction, client, userData, amount, multiplier);
    const won = multiplier > 0;
    const embed = (won ? successEmbed : warningEmbed)(won ? 'Baccarat — You won!' : 'Baccarat — You lost',
      `Player: **${player.map(label).join(', ')}** (${playerScore})\nBanker: **${banker.map(label).join(', ')}** (${bankerScore})\n\nWinner: **${winner}**${won ? ` — you received **${money(result.payout)}**.` : ` — you lost **${money(amount)}**.`}`)
      .addFields({ name: 'Cash balance', value: money(result.balance), inline: true });
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
  }, { command: 'baccarat' }),
};
