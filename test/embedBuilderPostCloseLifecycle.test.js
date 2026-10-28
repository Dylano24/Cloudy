import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = readFileSync(new URL('../src/commands/Tools/embedbuilder.js', import.meta.url), 'utf8');

test('posting an embed does not close the root Builder while Close message is still rendered', () => {
  const start = file.indexOf('async function postMessage(');
  const end = file.indexOf('\nexport default {', start);
  assert.ok(start > 0 && end > start, 'Post handler exists');
  const postHandler = file.slice(start, end);
  assert.match(postHandler, /collector\.stop\('posted'\)/,
    'the completed channel picker itself must stop');
  assert.doesNotMatch(postHandler, /state\.finishBuilder\?\.\('posted'\)/,
    'the root Builder must remain interactive after the channel picker finishes');
  assert.match(postHandler, /refreshBuilder\(buttonInteraction, state\)/,
    'the visible dashboard must refresh after a successful post');
  assert.match(file, /case 'simple_embed_close':\s*await buttonInteraction\.deferUpdate\(\)/,
    'Close message must acknowledge the click before cleanup');
  assert.match(file, /collector\.stop\('manual-close'\)/,
    'Close message is still an explicit session termination');
});

test('successful Post invalidates Search choices after durable registration, not before', () => {
  const start = file.indexOf('async function postBuiltMessage(');
  const end = file.indexOf('\nfunction buildControlEmbed(', start);
  assert.ok(start > 0 && end > start);
  const post = file.slice(start, end);
  const registered = post.indexOf("await registerCloudyEmbedMessage(sent, 'embed-builder'");
  const invalidated = post.indexOf('invalidateBuilderSearchTitleCache(guild.id);');
  const returned = post.indexOf('return { ok: true, destination: channel');
  assert.ok(registered > 0 && invalidated > registered && returned > invalidated,
    'Search must be invalidated only after a durable successful post');
});

test('all canonical action labels remain visible and slash registration stays unchanged', () => {
  for (const value of ['Close message', 'Save changes', 'Post', 'Reset', 'Remove logo']) {
    assert.ok(file.includes(value), value + ' must remain available');
  }
  assert.match(file, /\.setName\('embedbuilder'\)/);
});
