import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_HELP, gameHelpRow } from '../src/services/gameHelpService.js';

test('all casino games use How to play without changing their button actions', () => {
  for (const game of ['blackjack', 'baccarat', 'roulette']) {
    const row = gameHelpRow(game).toJSON();
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].label, 'How to play');
    assert.equal(row.components[0].custom_id, `game_help:${game}`);
  }
});

test('blackjack game guide uses the same Double down capitalization', () => {
  assert.match(GAME_HELP.blackjack, /\*\*Double down:\*\*/);
});
