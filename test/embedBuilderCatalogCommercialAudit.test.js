import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { getBuiltInSystemCatalogDefinitions } from '../src/services/systemEmbedCatalogService.js';
import { recordTitle } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const FORBIDDEN_VISIBLE = /\{dynamic\}|\b(?:botlog|bot log|source:[a-z0-9]|embed:[a-z0-9]|variant\s+\d+)\b/i;

function fakeRecord(definition, index) {
  return {
    guildId: 'commercial-audit',
    channelId: '100000000000000001',
    messageId: String(900000000000000000n + BigInt(index)),
    embedIndex: 0,
    source: 'system-catalog',
    name: definition.title || definition.label || 'Cloudy response',
    title: definition.title || definition.label || 'Cloudy response',
    snapshot: {
      title: definition.title || definition.label || undefined,
      description: definition.description || definition.content || undefined,
      fields: definition.fields || [],
      footer: definition.footer || null,
      color: definition.color,
    },
  };
}

test('every built-in system response has one stable identity and a clean commercial Search name', () => {
  const definitions = getBuiltInSystemCatalogDefinitions();
  assert.ok(definitions.length > 0);

  const identities = new Set();
  for (const [index, definition] of definitions.entries()) {
    assert.ok(definition.key, `missing key at built-in index ${index}`);
    assert.ok(definition.context, `missing context for ${definition.key}`);

    const identity = `${definition.context}|${definition.key}`;
    assert.equal(identities.has(identity), false, `duplicate built-in identity: ${identity}`);
    identities.add(identity);

    const title = recordTitle(fakeRecord(definition, index));
    assert.ok(title, `empty commercial Search title for ${identity}`);
    assert.doesNotMatch(title, FORBIDDEN_VISIBLE, `technical Search title for ${identity}: ${title}`);
  }

  const removed = definitions.find(definition => definition.key === 'builder:removed');
  assert.ok(removed, 'builder:removed must always exist in the built-in catalog');
  assert.equal(recordTitle(fakeRecord(removed, 999)), 'Removed from Builder');
});

test('every source-discovered embed resolves to a clean commercial Search name', async () => {
  const definitions = (await discoverEmbedDefinitions()).filter(definition => definition.kind === 'embed');
  assert.ok(definitions.length > 0);

  for (const [index, definition] of definitions.entries()) {
    const title = recordTitle(fakeRecord(definition, 2000 + index));
    assert.ok(title, `empty Search title for discovered ${definition.context || 'unknown'}`);
    assert.doesNotMatch(
      title,
      FORBIDDEN_VISIBLE,
      `technical Search title for ${definition.context || 'unknown'}: ${title}`,
    );
  }
});


test('ephemeral AI answer files are excluded from reusable Embed Builder template discovery', async () => {
  const definitions = await discoverEmbedDefinitions();
  const forbiddenContexts = new Set([
    'faq/faq-ai-interaction',
    'botlog/cloudy-fix-guide-interaction',
  ]);

  const leaked = definitions.filter(definition =>
    definition.kind === 'embed' && forbiddenContexts.has(definition.context));
  assert.deepEqual(
    leaked,
    [],
    'user-specific ephemeral AI answers must never compete with the fixed FAQ/Fix Guide panels in Search',
  );
});


test('runtime Builder delete notice and catalog template keep the same commercial title', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(
    source,
    /sendBuilderDeleteNotice\([\s\S]*?'Removed from Builder'[\s\S]*?'The stale record and its Reappear rule were removed from the Embed Builder\.'/,
  );

  const removed = getBuiltInSystemCatalogDefinitions()
    .find(definition => definition.key === 'builder:removed');
  assert.ok(removed);
  assert.equal(removed.title, 'Removed from Builder');
  assert.equal(
    removed.description,
    'The stale record and its Reappear rule were removed from the Embed Builder.',
  );
});


test('Embed Builder UI internals are never source-discovered as reusable responses', async () => {
  const definitions = await discoverEmbedDefinitions();
  const forbidden = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
    'use the buttons below to create your message',
    '(use the buttons below to create your message)',
  ]);

  const leaked = definitions.filter(definition => {
    const title = String(definition.title || definition.label || '').trim().toLowerCase();
    return forbidden.has(title);
  });

  assert.deepEqual(
    leaked,
    [],
    'Embed Builder UI/status internals must never pollute the reusable Search catalog',
  );
});


test('fixed assistant panels remain complete source fallbacks while generated AI answers stay excluded', async () => {
  const definitions = await discoverEmbedDefinitions();

  const faqPanel = definitions.find(definition =>
    definition.kind === 'embed'
    && definition.context === 'faq/faq-ai-service'
    && definition.title === 'Cloudy Support Assistant');
  assert.ok(faqPanel);
  assert.match(faqPanel.description || '', /Click \*\*Ask a question\*\*/);

  const fixGuidePanel = definitions.find(definition =>
    definition.kind === 'embed'
    && definition.title === 'Cloudy Assistant • Fix Guide');
  assert.ok(fixGuidePanel);
  assert.match(fixGuidePanel.description || '', /Click \*\*❔ Ask\*\*/);

  assert.equal(
    definitions.some(definition =>
      definition.kind === 'embed'
      && /^Cloudy Fix Guide(?: • \d+)?$/.test(String(definition.title || ''))),
    false,
    'generated Fix Guide answers must not become reusable templates',
  );
});
