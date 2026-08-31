import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { setEconomyData } from '../../utils/economy.js';
import { takeBet, money } from './modules/casinoGameUtils.js';

// Hollow suit glyphs survive Cloudy's global emoji sanitiser while staying readable.
const SUITS = ['♤', '♡', '♢', '♧'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const makeDeck = () => {
  const cards = SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit, text: `${rank}${suit}` })));
  for (let i = cards.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
};
const draw = state => state.deck.pop();
const cardsText = cards => cards.map(card => card.text).join('  ');
const score = cards => {
  let total = 0; let aces = 0;
  for (const card of cards) { if (card.rank === 'A') { total += 11; aces += 1; } else total += ['J', 'Q', 'K'].includes(card.rank) ? 10 : Number(card.rank); }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
};
const isBlackjack = cards => cards.length === 2 && score(cards) === 21;

function controls(state, ended = false) {
  const hand = state.hands[state.current];
  const canDouble = hand.cards.length === 2 && state.data.wallet >= hand.bet;
  const canSplit = state.hands.length === 1 && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank && state.data.wallet >= hand.bet;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`casino_blackjack:hit:${state.id}`).setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(ended),
      new ButtonBuilder().setCustomId(`casino_blackjack:stand:${state.id}`).setLabel('Stand').setStyle(ButtonStyle.Success).setDisabled(ended),
      new ButtonBuilder().setCustomId(`casino_blackjack:double:${state.id}`).setLabel('Double Down').setStyle(ButtonStyle.Secondary).setDisabled(ended || !canDouble),
      new ButtonBuilder().setCustomId(`casino_blackjack:split:${state.id}`).setLabel('Split').setStyle(ButtonStyle.Secondary).setDisabled(ended || !canSplit),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`casino_blackjack:help:${state.id}`).setLabel('Help').setEmoji('❔').setStyle(ButtonStyle.Secondary).setDisabled(ended)),
  ];
}

function embed(state, result = null) {
  const hands = state.hands.map((hand, index) => `**${state.hands.length > 1 ? `Hand ${index + 1}` : 'Your Hand'}${!state.finished && index === state.current ? ' — Playing' : ''}**\n${cardsText(hand.cards)}\nValue: **${score(hand.cards)}**${score(hand.cards) > 21 ? ' — Bust' : ''}`).join('\n\n');
  const dealerCards = state.finished ? cardsText(state.dealer) : `${state.dealer[0].text}  🂠`;
  return createEmbed({
    title: result ? `Result: ${result.title}` : `Blackjack — Bet ${money(state.totalBet)}`,
    description: [result?.text, hands, `**Dealer Hand**\n${dealerCards}\nValue: **${state.finished ? score(state.dealer) : '?'}**`, `Cards remaining: **${state.deck.length}**`].filter(Boolean).join('\n\n'),
    color: result?.color || 'primary', author: { name: state.user.username, iconURL: state.user.displayAvatarURL() },
  });
}

function dealerDraw(state) { while (score(state.dealer) < 17) state.dealer.push(draw(state)); }

async function settle(state, component, collector) {
  state.finished = true; dealerDraw(state);
  const dealerScore = score(state.dealer); let payout = 0; const outcomes = [];
  for (const hand of state.hands) {
    const handScore = score(hand.cards);
    if (handScore > 21) outcomes.push('Bust');
    else if (isBlackjack(hand.cards) && state.hands.length === 1) { payout += Math.floor(hand.bet * 2.5); outcomes.push('Blackjack'); }
    else if (dealerScore > 21 || handScore > dealerScore) { payout += hand.bet * 2; outcomes.push('Win'); }
    else if (handScore === dealerScore) { payout += hand.bet; outcomes.push('Push'); }
    else outcomes.push('Loss');
  }
  state.data.wallet += payout; await setEconomyData(state.client, state.guildId, state.user.id, state.data);
  const result = { title: outcomes.join(' / '), color: payout > state.totalBet ? 'success' : payout === state.totalBet ? 'primary' : 'error', text: `Payout: **${money(payout)}**\nCash balance: **${money(state.data.wallet)}**` };
  await component.update({ embeds: [embed(state, result)], components: controls(state, true) }); collector.stop('finished');
}

export default {
  data: new SlashCommandBuilder().setName('blackjack').setDescription('Play interactive blackjack')
    .addIntegerOption(option => option.setName('amount').setDescription('Cash to bet').setRequired(true).setMinValue(1)),
  category: 'Economy',
  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction); if (!deferred) return;
    const { amount, userData } = await takeBet(interaction, client); await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
    const deck = makeDeck();
    const state = { id: interaction.id, client, guildId: interaction.guildId, user: interaction.user, data: userData, deck, dealer: [deck.pop(), deck.pop()], hands: [{ cards: [deck.pop(), deck.pop()], bet: amount, done: false }], current: 0, totalBet: amount, finished: false };
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed(state)], components: controls(state) });
    const message = await interaction.fetchReply().catch(() => null);
    if (!message?.createMessageComponentCollector) return;
    const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && i.customId.endsWith(`:${state.id}`), time: 10 * 60 * 1000 });
    let busy = false;
    collector.on('collect', async component => {
      if (busy || state.finished) return; busy = true;
      try {
        const action = component.customId.split(':')[1];
        if (action === 'help') { await component.reply({ ephemeral: true, content: '**Hit:** draw a card. **Stand:** finish your hand. **Double Down:** double your bet, draw once, then stand. **Split:** play two hands when your first two cards match.' }); return; }
        const hand = state.hands[state.current];
        if (action === 'hit') hand.cards.push(draw(state));
        if (action === 'stand') hand.done = true;
        if (action === 'double') {
          if (hand.cards.length !== 2 || state.data.wallet < hand.bet) throw createError('Double unavailable', ErrorTypes.VALIDATION, 'You cannot double this hand.');
          state.data.wallet -= hand.bet; state.totalBet += hand.bet; hand.bet *= 2; hand.cards.push(draw(state)); hand.done = true;
        }
        if (action === 'split') {
          if (state.hands.length !== 1 || hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank || state.data.wallet < hand.bet) throw createError('Split unavailable', ErrorTypes.VALIDATION, 'You can only split a matching pair when you have enough cash.');
          state.data.wallet -= hand.bet; state.totalBet += hand.bet;
          state.hands = [{ cards: [hand.cards[0], draw(state)], bet: hand.bet, done: false }, { cards: [hand.cards[1], draw(state)], bet: hand.bet, done: false }]; state.current = 0;
        }
        if (score(hand.cards) >= 21) hand.done = true;
        if (hand.done && state.current < state.hands.length - 1) { state.current += 1; await component.update({ embeds: [embed(state)], components: controls(state) }); return; }
        if (state.hands.every(current => current.done || score(current.cards) > 21)) { await settle(state, component, collector); return; }
        await component.update({ embeds: [embed(state)], components: controls(state) });
      } catch (error) { await component.reply({ ephemeral: true, content: error.userMessage || 'That action cannot be used now.' }).catch(() => {}); }
      finally { busy = false; }
    });
    collector.on('end', async (_, reason) => {
      if (reason === 'finished' || state.finished) return;
      state.finished = true; state.data.wallet += state.totalBet; await setEconomyData(client, interaction.guildId, interaction.user.id, state.data);
      await message.edit({ embeds: [embed(state, { title: 'Expired', color: 'warning', text: `Game expired — **${money(state.totalBet)}** was returned.` })], components: controls(state, true) }).catch(() => {});
    });
  }, { command: 'blackjack' }),
};
