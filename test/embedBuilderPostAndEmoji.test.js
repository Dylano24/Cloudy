import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildControls, buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { humanSearchChoiceTitle } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function buttonIds(rows) {
  return rows.flatMap(row => row.components.map(button => button.data?.custom_id || button.customId));
}

test('Builder always keeps Save and Post as separate visible controls', () => {
  const newDraft = { title: 'Draft', message: 'Test', sideColor: 0xFFFFFF };
  const editing = { ...newDraft, modifyTarget: { messageId: 'existing', channelId: 'general' } };
  const deleted = { ...newDraft, pendingBuilderDelete: null };
  for (const draft of [newDraft, editing, deleted]) {
    const rows = buildControls(draft);
    const ids = buttonIds(rows);
    assert.ok(ids.includes('simple_embed_post'), 'Save must remain present');
    assert.ok(ids.includes('simple_embed_post_new'), 'Post must remain separately present');
    assert.ok(ids.includes('simple_embed_delete_from_builder'), 'Delete must remain present');
    assert.equal(rows.length, 5, 'preserve existing five-row Builder');
    assert.ok(rows.every(row => row.components.length <= 5), 'Discord permits five buttons per row');
  }
});

test('Builder title displays literal Discord custom emoji markup without backticks', () => {
  const name = 'Removed from builder <a:W81yesverifiedblue:123456789012345678>';
  const state = { title: name, message: 'A message', sideColor: 0x00C49D };
  const [preview, summary] = buildBuilderEmbeds(state);
  assert.equal(preview.toJSON().title, name, 'the real custom emoji is unchanged');
  const line = summary.toJSON().description.split('\n').find(row => row.startsWith('**Title**'));
  assert.ok(line.includes(name));
  assert.ok(!line.includes('`' + name + '`'), 'backticks would show the emoji markup as raw code');
});

test('Search autocomplete preserves custom emoji codes for every name without changing the preview title', () => {
  const original = 'Removed from builder <a:W81yesverifiedblue:123456789012345678>';
  assert.equal(humanSearchChoiceTitle(original), original);
  assert.equal(original, 'Removed from builder <a:W81yesverifiedblue:123456789012345678>');
  assert.equal(humanSearchChoiceTitle('Hello <a:unknown:123456789012345678>'), 'Hello <a:unknown:123456789012345678>');
  assert.equal(humanSearchChoiceTitle('Hello <a:X89rust10:123456789012345678>'), 'Hello <a:X89rust10:123456789012345678>');
});

test('posting persists the physical message with manualSave=true; explicit Delete is the only purge', () => {
  const src = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = src.indexOf('async function postBuiltMessage(');
  const end = src.indexOf('function buildControlEmbed(', start);
  assert.ok(start > 0 && end > start);
  const post = src.slice(start, end);
  assert.match(post, /registerCloudyEmbedMessage\(sent, 'embed-builder', \{[\s\S]*manualSave: true/);
  assert.match(post, /rollbackPost/);
  assert.match(post, /entry\.message\.delete/);
  const buttonStart = src.indexOf("case 'simple_embed_post_new':");
  assert.ok(buttonStart > 0);
  assert.match(src.slice(buttonStart, buttonStart + 170), /postMessage\(buttonInteraction, state, interaction\.guild, true\)/);
  assert.match(src, /async function postMessage\(buttonInteraction, state, guild, forceNew = false\)/);
});
