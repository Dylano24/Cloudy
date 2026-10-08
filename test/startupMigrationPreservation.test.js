import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { Collection } from 'discord.js';

test('startup event discovery cannot rewrite the manually saved ZORP Guide', async () => {
  const files = await readdir(new URL('../src/events/', import.meta.url));
  const savedGuide = {
    title: 'ZORP Guide',
    fields: [{ name: 'Important information', value: 'Manually saved wording and spacing.\n⠀Keep this exactly.' }],
  };
  let currentGuide = structuredClone(savedGuide);
  const message = {
    id: '1554543233047199787', editable: true,
    embeds: [{ ...savedGuide, toJSON: () => structuredClone(savedGuide) }],
    edit: async payload => { currentGuide = payload.embeds[0]; return message; },
  };
  const channel = { isTextBased: () => true, messages: { fetch: async () => message } };
  const client = {
    channels: { cache: new Collection(), fetch: async () => channel },
    application: { emojis: { fetch: async () => new Collection([['spacer', { name: 'cloudy_zorp_indent', toString: () => '<:spacer:123>' }]]) } },
  };
  // Exercise the old startup hook if discovery still exposes it. This catches
  // its actual rewrite rather than checking the implementation's source text.
  if (files.includes('zorpSpacerAlignOnceReady.js')) {
    const { default: event } = await import('../src/events/zorpSpacerAlignOnceReady.js');
    await event.execute(client);
  }
  assert.deepEqual(currentGuide, savedGuide);
});

test('event discovery excludes the expired September 29 read-only inventory hook', async () => {
  const files = await readdir(new URL('../src/events/', import.meta.url));
  assert.equal(files.includes('cloudyReadonlyInventoryReady.js'), false);
});
