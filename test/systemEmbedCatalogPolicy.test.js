import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  applyRuntimeEmbedTemplateData,
  captureSystemEmbedData,
  cleanupSystemCatalogEntries,
  getSystemEmbedTemplateKey,
  isEditableSystemCatalogTemplate,
  primeSystemEmbedTemplateData,
  registerDiscoveredEmbedDefinition,
  TICKET_LOG_CATALOG_TEMPLATES,
} from '../src/services/systemEmbedCatalogService.js';
import { prefersCatalogPreview } from '../src/services/embedManagerService.js';

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

test('generic response templates collapse cosmetic title variants into one command-scoped type', () => {
  const context = 'gambling/crime';
  const full = getSystemEmbedTemplateKey(
    'embed',
    '🚔 Crime Failed!',
    'You were caught while attempting Cybercrime and have been sent to jail! You were fined 2,500 coins and will be in jail for 2 hours.',
    context,
  );
  const source = getSystemEmbedTemplateKey(
    'embed',
    'Crime failed',
    'You were caught while attempting {dynamic} and have been sent to jail!',
    context,
  );

  assert.equal(full, source);
  assert.match(full, /^embed-type:/);
  assert.notEqual(
    full,
    getSystemEmbedTemplateKey('embed', 'Crime Successful!', 'Success', context),
  );
  assert.notEqual(
    full,
    getSystemEmbedTemplateKey('embed', 'Crime failed', 'Same title', 'gambling/rob'),
  );
});

test('a saved source embed title remains authoritative for the live dynamic response', () => {
  const context = 'gambling/rob-source-alias-test';
  const sourceTitle = 'Robbery Failed';
  const sourceKey = getSystemEmbedTemplateKey('embed', sourceTitle, '', context);

  registerDiscoveredEmbedDefinition({
    kind: 'embed',
    title: sourceTitle,
    context,
    variantId: 'commands/Economy/rob.js:embed:source-alias-test',
  });

  assert.equal(primeSystemEmbedTemplateData(sourceKey, context, {
    title: 'Robbery failed',
    description: 'You failed the robbery and were caught. You were fined **{dynamic}** of your own cash.',
    color: 0x7A1712,
  }), true);

  const rendered = applyRuntimeEmbedTemplateData({
    title: sourceTitle,
    description: 'You failed the robbery and were caught. You were fined **$25** of your own cash.',
    color: 0xFFFFFF,
  }, { commandName: 'rob-source-alias-test' });

  assert.equal(rendered.title, 'Robbery failed');
  assert.equal(rendered.description, 'You failed the robbery and were caught. You were fined **$25** of your own cash.');
  assert.equal(rendered.color, 0x7A1712);
});

test('a real response wins the first Builder preview over a sparse catalog card', () => {
  assert.equal(prefersCatalogPreview([
    { source: 'system-catalog', snapshot: { title: 'Robbery failed' } },
    { source: 'modified', snapshot: { title: 'Robbery failed', description: 'Full live response' } },
  ]), false);
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

test('only the ten explicit ticket lifecycle masters are permanent catalog templates', () => {
  assert.equal(TICKET_LOG_CATALOG_TEMPLATES.length, 10);
  assert.equal(new Set(TICKET_LOG_CATALOG_TEMPLATES.map(template => template.key)).size, 10);
  assert.deepEqual(
    TICKET_LOG_CATALOG_TEMPLATES.map(template => template.key).sort(),
    [
      'ticket-log:claim',
      'ticket-log:close',
      'ticket-log:delete',
      'ticket-log:feedback',
      'ticket-log:open',
      'ticket-log:pin',
      'ticket-log:priority',
      'ticket-log:transcript',
      'ticket-log:unclaim',
      'ticket-log:unpin',
    ],
  );
  for (const template of TICKET_LOG_CATALOG_TEMPLATES) {
    assert.equal(isEditableSystemCatalogTemplate(template.key, template.context), true);
  }
  assert.equal(isEditableSystemCatalogTemplate('embed:deadbeef', 'tickets/temporary-status'), false);
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

test('background catalog cleanup preserves every existing embed until an explicit Builder Save', async () => {
  const template = (title, key, context) => new EmbedBuilder({
    title,
    description: 'Template body',
    author: {
      name: `Cloudy template key: ${key} || Cloudy context: ${context} || Cloudy kind: embed`,
    },
  });

  const message = {
    id: 'catalog-message-1',
    embeds: [
      template('Result: Bust', 'game:blackjack:result:bust', 'gambling/blackjack'),
      template('Result: Bus', 'game:blackjack:result:bus', 'gambling/blackjack'),
      template('Result: Bu', 'game:blackjack:result:bu', 'gambling/blackjack'),
      template('Ticket closed', 'embed:deadbeef', 'tickets/close'),
      template('Ticket deleted', 'ticket-log:delete', 'ticket-logs/delete'),
    ],
    async edit() {
      assert.fail('Background catalog cleanup must not rewrite an existing embed');
    },
  };
  const messages = [message];
  const before = JSON.stringify(message.embeds.map(embed => embed.toJSON()));

  assert.equal(await cleanupSystemCatalogEntries(messages), false);
  assert.equal(messages.length, 1);
  assert.equal(message.embeds.length, 5);
  assert.equal(JSON.stringify(message.embeds.map(embed => embed.toJSON())), before);
});
