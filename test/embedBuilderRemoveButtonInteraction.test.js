import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { removeRightmostBuilderButton } from '../src/services/embedBuilderButtonEditorService.js';

test('dashboard Remove handles newly added buttons and removes one per concurrent click', async () => {
  const source = readFileSync(new URL('../src/commands/Tools/embedbuilder.js', import.meta.url), 'utf8');
  const body = source.match(/case 'simple_embed_remove_buttons':\s*\{([\s\S]*?)\n\s*break;\s*\}/)?.[1];
  assert.ok(body, 'visible Remove button must have a handler');
  const handle = new Function('buttonInteraction', 'state', 'hydrateBuilderMessageComponents', 'removeRightmostBuilderButton', 'refreshBuilder', `return (async () => {${body}})();`);
  const state = { componentRows: [{ type: 1, components: ['Existing', 'Added', 'Added again'].map(label => ({ type: 2, style: 2, label, custom_id: label })) }], componentsDirty: true };
  let acknowledgements = 0;
  let refreshes = 0;
  const interaction = { guild: {}, deferUpdate: async () => { acknowledgements++; } };
  const hydrate = async (_guild, current) => { assert.equal(current.componentsDirty, true); };
  const refresh = async () => { refreshes++; };
  await handle(interaction, state, hydrate, removeRightmostBuilderButton, refresh);
  assert.equal(state.componentRows[0].components.length, 2);
  await Promise.all([handle(interaction, state, hydrate, removeRightmostBuilderButton, refresh), handle(interaction, state, hydrate, removeRightmostBuilderButton, refresh)]);
  assert.deepEqual(state.componentRows, []);
  await handle(interaction, state, hydrate, removeRightmostBuilderButton, refresh);
  assert.deepEqual(state.componentRows, []);
  assert.equal(acknowledgements, 4);
  assert.equal(refreshes, 4);
});
