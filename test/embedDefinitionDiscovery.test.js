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
