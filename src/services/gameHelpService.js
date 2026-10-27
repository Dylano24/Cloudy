import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { setResponseLifetime } from '../utils/responseLifetime.js';

export const GAME_HELP = {
  blackjack: [
    '**How to play blackjack**',
    'Beat the dealer by getting closer to **21** without going over. Going over 21 is a bust and loses your bet. If the dealer busts and you do not, you win. Matching totals return your bet.',
    '**Card values:** 2 to 10 count as their number. J, Q and K count as 10. An ace counts as 1 or 11, whichever keeps your hand at 21 or below. The dealer draws until reaching at least 17.',
    '**Hit:** draw another card.\n**Stand:** keep your total and let the dealer play.\n**Double Down:** add an equal bet, draw exactly one card, then stand. Available on a two card hand with enough cash.\n**Split:** split two matching ranks into two hands with an equal extra bet. Play each hand separately.',
  ].join('\n\n'),
  baccarat: [
    '**How to play baccarat**',
    'Choose **Player**, **Banker**, or **Tie** before the cards are dealt. You win when your choice matches the result. Player and Banker are the names of the two hands.',
    '**Card values:** an ace counts as 1, cards 2 to 9 count as their number, and 10, J, Q and K count as 0. Only the last digit of the total counts: 7 + 8 = 15, so the hand is worth 5.',
    'The hand closest to **9** wins. In this bot, each hand automatically draws one extra card if its first two cards total less than 6. You do not need to draw or stand.',
    '**Player:** a win returns 2 times your bet.\n**Banker:** a win returns 1.95 times your bet, rounded down.\n**Tie:** a win returns 9 times your bet.\nThese returns include your original bet. A tie returns Player and Banker bets.',
  ].join('\n\n'),
  roulette: [
    '**How to play roulette**',
    'Choose your bet with `/roulette amount bet`. The wheel lands on a number from **0 to 36**. You win if that number matches your choice.',
    '**Red / black:** predict the colour.\n**Even / odd:** predict whether the number is even or odd.\n**0 to 36:** predict the exact number.',
    '**Payouts:** a winning colour or even/odd bet returns 2 times your bet. A winning exact number returns 36 times your bet. Returns include your original bet.',
    '**Zero is green:** red, black, even and odd bets all lose on 0. An exact bet on 0 wins when the wheel lands on 0.',
  ].join('\n\n'),
};

export function gameHelpRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`game_help:${game}`).setLabel('Help').setEmoji('❔').setStyle(ButtonStyle.Secondary),
  );
}

export async function replyPrivateGuide(interaction, payload) {
  // This response has an explicit five minute lifetime, independent of status
  // title heuristics. Delete only the click's private response, never its panel.
  setResponseLifetime(interaction, null);
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  const timer = setTimeout(() => interaction.deleteReply().catch(() => {}), 5 * 60_000);
  timer.unref?.();
}
