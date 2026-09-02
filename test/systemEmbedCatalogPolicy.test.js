import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureSystemEmbedData,
  getSystemEmbedTemplateKey,
  isEditableSystemCatalogTemplate,
} from '../src/services/systemEmbedCatalogService.js';

test('Blackjack result templates accept only real final game states', () => {
  const context = 'gambling/blackjack';

  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Bust', '', context), 'game:blackjack:result:bust');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Blackjack', '', context), 'game:blackjack:result:blackjack');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Win', '', context), 'game:blackjack:result:win');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Push', '', context), 'game:blackjack:result:push');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Loss', '', context), 'game:blackjack:result:loss');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Expired', '', context), 'game:blackjack:result:expired');
  assert.equal(getSystemEmbedTemplateKey('embed', 'Result: Win / Loss', '', context), 'game:blackjack:result:win-loss');
});

test('partial Blackjack titles can never become persistent templates', () => {
  const context = 'gambling/blackjack';

  for (const title of ['Result: Bus', 'Result: Bu', 'Result:', 'Result', 'Resul', 'Res', 'B', 'Bu']) {
    assert.equal(getSystemEmbedTemplateKey('embed', title, '', context), '', title);
  }

  assert.equal(isEditableSystemCatalogTemplate('game:blackjack:result:bu', context), false);
  assert.equal(isEditableSystemCatalogTemplate('game:blackjack:result:win-loss', context), true);
});

test('roulette and baccarat keep only their real reusable states', () => {
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Roulette — You won!', '', 'gambling/roulette'),
    'game:roulette:won',
  );
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Roulette — You lost', '', 'gambling/roulette'),
    'game:roulette:lost',
  );
  assert.equal(getSystemEmbedTemplateKey('embed', 'Roulette — You lo', '', 'gambling/roulette'), '');

  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Baccarat — Bet $100', '', 'gambling/baccarat'),
    'game:baccarat:bet',
  );
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Baccarat — Result', '', 'gambling/baccarat'),
    'game:baccarat:result',
  );
  assert.equal(getSystemEmbedTemplateKey('embed', 'Baccarat — Res', '', 'gambling/baccarat'), '');
});

test('ticket runtime output is never promoted into the system template catalog', () => {
  assert.equal(isEditableSystemCatalogTemplate('embed:deadbeef', 'tickets/close'), false);
  assert.equal(
    captureSystemEmbedData(
      { title: 'Ticket closed', description: 'Closed by a moderator.' },
      { commandName: 'ticket-close' },
    ),
    false,
  );
});

test('malformed casino runtime output is rejected before it can queue a catalog write', () => {
  assert.equal(
    captureSystemEmbedData(
      { title: 'Result: Bu', description: 'temporary title while editing' },
      { commandName: 'blackjack' },
    ),
    false,
  );
});
