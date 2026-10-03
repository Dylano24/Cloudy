import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverEmbedDefinitions, extractDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';

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

  for (const definition of [success, failed]) {
    assert.equal(definition.fields?.length, 2);
    assert.equal(definition.fields[0].name, 'Your new cash ({dynamic})');
    assert.equal(definition.fields[0].value, '{dynamic}');
    assert.equal(definition.fields[1].name, "Victim's new cash ({dynamic})");
    assert.equal(definition.fields[1].value, '{dynamic}');
    assert.equal(definition.footer?.text, 'Next robbery available in {dynamic} hours.');
  }

  assert.equal(
    rob.some(definition =>
      definition.title === 'Success'
      && definition.description === 'Robbery successful'
    ),
    false,
  );
});


test('source discovery keeps the complete concatenated Crime failed body', async () => {
  const definitions = await discoverEmbedDefinitions();
  const crime = definitions.filter(definition =>
    definition.kind === 'embed'
    && definition.context === 'gambling/crime'
  );

  const failed = crime.find(definition =>
    /crime failed/i.test(definition.title)
  );

  assert.ok(failed);
  assert.equal(
    failed.description,
    'You were caught while attempting {dynamic} and have been sent to jail! You were fined {dynamic} coins and will be in jail for 2 hours.',
  );
});


test('source discovery indexes the dynamic Balance title without a real Discord username', async () => {
  const definitions = await discoverEmbedDefinitions();
  const balance = definitions.find(definition =>
    definition.kind === 'embed'
    && definition.context === 'gambling/balance'
    && definition.title === "{dynamic}'s Balance"
  );

  assert.ok(balance, 'Balance must exist in the source catalog before a user runs /balance');
  assert.equal(
    balance.description,
    'Here is the current financial status for {dynamic}.',
  );
  assert.equal(balance.fields?.length, 3);
  assert.deepEqual(
    balance.fields.map(field => field.name),
    ['💵 Cash', '🏦 Bank', '💰 Total'],
  );
  assert.match(balance.footer?.text || '', /^Requested by \{dynamic\}$/);
  assert.doesNotMatch(balance.title, /feelfate|mindzset|dylano/i);
});


test('source discovery rejects calculated dynamic titles that would create fake Builder embeds', () => {
  const source = [
    "const result = createEmbed({",
    "  title: `Result ${score + 1}`,",
    "  description: 'Calculated runtime result',",
    "});",
    "const conditional = createEmbed({",
    "  title: `${won ? 'Win' : 'Loss'}`,",
    "  description: 'Conditional runtime result',",
    "});",
  ].join('\n');

  const definitions = extractDefinitions(source, 'commands/Economy/fake-runtime.js');
  assert.equal(definitions.some(definition => definition.title?.includes('{dynamic}')), false);
});

test('source discovery still accepts safe member-possessive titles', () => {
  const source = [
    "const embed = createEmbed({",
    "  title: `${targetUser.username}'s Balance`,",
    "  description: `Here is the balance for ${targetUser.username}.`,",
    "});",
  ].join('\n');

  const definitions = extractDefinitions(source, 'commands/Economy/member-balance.js');
  assert.equal(
    definitions.some(definition => definition.title === "{dynamic}'s Balance"),
    true,
  );
});
