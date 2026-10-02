import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';

test('source discovery keeps the complete Cloudy Support Assistant description', async () => {
  const definitions = await discoverEmbedDefinitions();
  const support = definitions.find(definition =>
    definition.kind === 'embed'
    && definition.title === 'Cloudy Support Assistant'
    && definition.context === 'faq/faq-ai-service'
  );

  assert.ok(support);
  assert.equal(
    support.description,
    [
      'Have a question or need help with something?',
      '',
      'Our AI Assistant can help you find answers to common questions, server information, features, commands, and more.',
      '',
      'You can ask your question in any language, and you’ll receive a response in the same language.',
      '',
      'Click **Ask a question** below and let Cloudy Inc. assist you.',
    ].join('\n'),
  );
});


test('source discovery preserves nested dynamic helper calls for robbery outcomes', async () => {
  const definitions = await discoverEmbedDefinitions();
  const rob = definitions.filter(definition =>
    definition.kind === 'embed'
    && definition.context === 'gambling/rob'
  );

  const success = rob.find(definition => definition.title === 'Robbery successful');
  const failed = rob.find(definition => definition.title === 'Robbery failed');

  assert.ok(success);
  assert.equal(
    success.description,
    'You successfully stole **{dynamic}** from {dynamic}!',
  );

  assert.ok(failed);
  assert.equal(
    failed.description,
    'You failed the robbery and were caught! You were fined **{dynamic}** of your own cash.',
  );

  assert.equal(
    rob.some(definition =>
      definition.title === 'Success'
      && definition.description === 'Robbery successful'
    ),
    false,
  );
});
