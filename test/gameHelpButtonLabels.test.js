import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAME_HELP, gameHelpRow } from '../src/services/gameHelpService.js';
import { isPrivateCasinoHelpInteraction } from '../src/events/fullResponseCatalogReady.js';

test('all casino games use How to play without changing their button actions', () => {
  for (const game of ['blackjack', 'baccarat', 'roulette']) {
    const row = gameHelpRow(game).toJSON();
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].label, '❔ How to play');
    assert.equal(row.components[0].emoji, undefined, 'Discord must not add a separate emoji gap');
    assert.equal(row.components[0].custom_id, `game_help:${game}`);
  }
});

test('blackjack game guide uses the same Double down capitalization', () => {
  assert.match(GAME_HELP.blackjack, /\*\*Double down:\*\*/);
  assert.doesNotMatch(GAME_HELP.blackjack, /Double Down/);
});

test('blackjack expires after the same two-minute period as baccarat and refunds its bet', () => {
  const blackjack = readFileSync(new URL('../src/commands/Economy/blackjack.js', import.meta.url), 'utf8');
  const baccarat = readFileSync(new URL('../src/commands/Economy/baccarat.js', import.meta.url), 'utf8');
  assert.match(baccarat, /time:\s*2\s*\*\s*60\s*\*\s*1000/);
  assert.match(blackjack, /time:\s*2\s*\*\s*60\s*\*\s*1000/);
  assert.match(blackjack, /adjustCasinoBalance\(client, interaction\.guildId, interaction\.user\.id, state\.totalBet\)/);
  assert.match(blackjack, /Game expired\. \*\*\$\{money\(state\.totalBet\)\}\*\* was returned\./);
  assert.match(blackjack, /payload\(state, \{ title: 'Expired'/);
});

test('private casino guides bypass saved response templates so their text stays current', () => {
  for (const game of ['blackjack', 'baccarat', 'roulette']) {
    assert.equal(isPrivateCasinoHelpInteraction({ customId: `game_help:${game}` }), true);
  }
  assert.equal(isPrivateCasinoHelpInteraction({ customId: 'game_help:other' }), false);
  assert.equal(isPrivateCasinoHelpInteraction({ customId: 'casino_blackjack:double:123' }), false);
  assert.equal(isPrivateCasinoHelpInteraction({ commandName: 'blackjack' }), false);
});
