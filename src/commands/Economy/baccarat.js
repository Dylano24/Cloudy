import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { setEconomyData } from '../../utils/economy.js';
import { takeBet, money } from './modules/casinoGameUtils.js';
import { renderCardRows } from './modules/casinoCardRenderer.js';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const value = card => card.rank === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(card.rank) ? 0 : Number(card.rank);
const score = cards => cards.reduce((total, card) => total + value(card), 0) % 10;
function deck() {
  const cards = SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));
  for (let i = cards.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
}
function choices(id, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`casino_baccarat:player:${id}`).setLabel('Player').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`casino_baccarat:banker:${id}`).setLabel('Banker').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`casino_baccarat:tie:${id}`).setLabel('Tie').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}
function gameEmbed(user, amount, player = null, banker = null, result = null, withCards = false) {
  const description = result
    ? `**Player Hand**\nValue: **${score(player)}**\n\n**Banker Hand**\nValue: **${score(banker)}**\n\n${result}`
    : `Bet: **${money(amount)}**\n\nChoose where to place your bet.`;
  return createEmbed({
    title: result ? 'Baccarat — Result' : 'Baccarat',
    description,
    color: result ? 'success' : 'primary',
    author: { name: user.username, iconURL: user.displayAvatarURL() },
    image: withCards ? 'attachment://baccarat-cards.png' : null,
  });
}
function resultPayload(user, amount, player, banker, result, id) {
  return {
    embeds: [gameEmbed(user, amount, player, banker, result, true)],
    components: choices(id, true),
    attachments: [],
    files: [{ attachment: renderCardRows([{ cards: player }, { cards: banker }]), name: 'baccarat-cards.png' }],
  };
}

export default {
  data: new SlashCommandBuilder().setName('baccarat').setDescription('Play interactive baccarat')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction); if (!deferred) return;
    const { amount, userData } = await takeBet(interaction, client); await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
    await InteractionHelper.safeEditReply(interaction, { embeds: [gameEmbed(interaction.user, amount)], components: choices(interaction.id) });
    const message = await interaction.fetchReply().catch(() => null);
    if (!message?.createMessageComponentCollector) return;
    const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && i.customId.endsWith(`:${interaction.id}`), time: 2 * 60 * 1000, max: 1 });
    collector.on('collect', async component => {
      const pick = component.customId.split(':')[1]; const cards = deck(); const player = [cards.pop(), cards.pop()]; const banker = [cards.pop(), cards.pop()];
      if (score(player) < 6) player.push(cards.pop());
      if (score(banker) < 6) banker.push(cards.pop());
      const playerScore = score(player), bankerScore = score(banker); const winner = playerScore === bankerScore ? 'tie' : playerScore > bankerScore ? 'player' : 'banker';
      const multiplier = pick === winner ? winner === 'tie' ? 9 : winner === 'banker' ? 1.95 : 2 : 0;
      const payout = Math.floor(amount * multiplier); userData.wallet += payout; await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
      const result = `You chose **${pick}**. Winner: **${winner}**\n${payout ? `Payout: **${money(payout)}**` : `You lost **${money(amount)}**`}\nCash balance: **${money(userData.wallet)}**`;
      await component.update(resultPayload(interaction.user, amount, player, banker, result, interaction.id));
    });
    collector.on('end', async collected => {
      if (collected.size) return;
      userData.wallet += amount; await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
      await message.edit({ embeds: [gameEmbed(interaction.user, amount, null, null, `Game expired — **${money(amount)}** was returned.`)], components: choices(interaction.id, true) }).catch(() => {});
    });
  }, { command: 'baccarat' }),
};
