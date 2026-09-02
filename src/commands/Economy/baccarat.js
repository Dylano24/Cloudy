import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { setEconomyData } from '../../utils/economy.js';
import { takeBet, money } from './modules/casinoGameUtils.js';
import { cardsEmojiLine } from './modules/casinoCardEmojis.js';

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
async function gameEmbed(client, user, amount, player = null, banker = null, result = null, outcome = null) {
  const fields = player?.length && banker?.length ? [
    { name: 'Player Hand', value: `${await cardsEmojiLine(client, player)}\nValue: **${score(player)}**`, inline: true },
    { name: 'Banker Hand', value: `${await cardsEmojiLine(client, banker)}\nValue: **${score(banker)}**`, inline: true },
  ] : [];

  const game = createEmbed({
    title: result ? `Baccarat ${outcome || 'result'}` : `Baccarat — Bet ${money(amount)}` ,
    description: result || 'Choose where to place your bet.',
    color: result ? 'success' : 'primary',
    author: { name: user.username, iconURL: user.displayAvatarURL() },
    fields,
  });

  // Preserve exact application-emoji markup in Discord while the complete fields
  // are also registered in the automatic system embed catalog / embed builder.
  if (fields.length) game.data.fields = fields;
  return game;
}

export default {
  data: new SlashCommandBuilder().setName('baccarat').setDescription('Play interactive baccarat')
    .addIntegerOption(option => option.setName('amount').setDescription('Bet any cash amount you can afford').setRequired(true).setMinValue(1)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction); if (!deferred) return;
    const { amount, userData } = await takeBet(interaction, client); await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
    await InteractionHelper.safeEditReply(interaction, { embeds: [await gameEmbed(client, interaction.user, amount)], components: choices(interaction.id) });
    const message = await interaction.fetchReply().catch(() => null);
    if (!message?.createMessageComponentCollector) return;
    const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && i.customId.endsWith(`:${interaction.id}`), time: 2 * 60 * 1000, max: 1 });
    collector.on('collect', async component => {
      const pick = component.customId.split(':')[1]; const cards = deck(); const player = [cards.pop(), cards.pop()]; const banker = [cards.pop(), cards.pop()];
      if (score(player) < 6) player.push(cards.pop());
      if (score(banker) < 6) banker.push(cards.pop());
      const playerScore = score(player), bankerScore = score(banker); const winner = playerScore === bankerScore ? 'tie' : playerScore > bankerScore ? 'player' : 'banker';

      let payout = 0;
      let outcome = 'loss';
      let outcomeText = '';
      if (winner === 'tie' && pick !== 'tie') {
        outcome = 'tie';
        payout = amount;
        outcomeText = `Tie — your **${money(amount)}** bet was returned.`;
      } else if (pick === winner) {
        outcome = 'win';
        const multiplier = winner === 'tie' ? 9 : winner === 'banker' ? 1.95 : 2;
        payout = Math.floor(amount * multiplier);
        outcomeText = `Payout: **${money(payout)}**`;
      } else {
        outcomeText = `You lost **${money(amount)}**`;
      }

      userData.wallet += payout; await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
      const result = `You chose **${pick}**. Winner: **${winner}**\n${outcomeText}\nCash balance: **${money(userData.wallet)}**`;
      await component.update({ embeds: [await gameEmbed(client, interaction.user, amount, player, banker, result, outcome)], components: choices(interaction.id, true), attachments: [] });
    });
    collector.on('end', async collected => {
      if (collected.size) return;
      userData.wallet += amount; await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
      await message.edit({ embeds: [await gameEmbed(client, interaction.user, amount, null, null, `Game expired — **${money(amount)}** was returned.`, 'expired')], components: choices(interaction.id, true), attachments: [] }).catch(() => {});
    });
  }, { command: 'baccarat' }),
};
