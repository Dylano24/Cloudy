import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import {
  buildMatches,
  buildSearchChoices,
  filterEmbedBuilderSearchRecords,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function channel(id, { view = true, send = true } = {}) {
  return {
    id,
    guildId: 'guild',
    name: id,
    permissionsFor() {
      return {
        has(requested) {
          const values = Array.isArray(requested) ? requested : [requested];
          if (values.includes(PermissionFlagsBits.ViewChannel) && !view) return false;
          if (values.includes(PermissionFlagsBits.SendMessages) && !send) return false;
          return true;
        },
      };
    },
  };
}

function guild(...channels) {
  return {
    id: 'guild',
    channels: { cache: new Map(channels.map(item => [item.id, item])) },
  };
}

const member = { id: 'owner' };

test('Search exposes system catalog responses even when their private backing channel is not visible', () => {
  const botlog = channel('botlog', { view: false, send: false });
  const g = guild(botlog);
  const removed = {
    guildId: g.id,
    channelId: botlog.id,
    backingChannelId: botlog.id,
    messageId: '100000000000000001',
    embedIndex: 0,
    source: 'system-catalog',
    name: 'Removed from Builder',
    title: 'Removed from Builder',
    snapshot: {
      title: 'Removed from Builder',
      description: 'The stale record and its Reappear rule were removed from the Embed Builder.',
      author: {
        name: 'Cloudy template key: builder:removed || Cloudy context: embed-builder/delete || Cloudy kind: embed',
      },
    },
  };

  const filtered = filterEmbedBuilderSearchRecords(g, member, [removed], { requireSend: true });
  assert.equal(filtered.length, 1);

  for (const query of ['removed from builder', 'deleted from builder']) {
    const matches = buildMatches(g, filtered, query);
    assert.equal(matches.length, 1, query);
    assert.equal(matches[0].document.title, 'Deleted from Builder');
    assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), ['Deleted from Builder']);
  }
});

test('Search finds a real Fix Guide by its logical channel even if internal backing/source channels are hidden', () => {
  const real = channel('bot-commands');
  const internal = channel('botlog', { view: false, send: false });
  const g = guild(real, internal);

  const fixGuide = {
    guildId: g.id,
    channelId: real.id,
    backingChannelId: internal.id,
    messageId: '100000000000000010',
    embedIndex: 0,
    source: 'embed-builder',
    name: 'Cloudy Fix Guide',
    title: 'Cloudy Fix Guide',
    snapshot: {
      title: 'Cloudy Fix Guide',
      description: 'Owner: {dynamic}',
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    },
    sourceRecord: {
      guildId: g.id,
      channelId: internal.id,
      backingChannelId: internal.id,
      messageId: '100000000000000011',
      embedIndex: 0,
      source: 'cloudy',
      snapshot: { title: 'Cloudy Fix Guide', description: 'Internal source copy' },
    },
  };

  const filtered = filterEmbedBuilderSearchRecords(g, member, [fixGuide], { requireSend: true });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sourceRecord, null, 'an inaccessible related live/source record must not leak');
  const matches = buildMatches(g, filtered, 'fix guide');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Cloudy fix guide');
  assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), ['Cloudy fix guide']);
});

test('Search still hides normal embeds when the invoking member cannot use their real logical channel', () => {
  const hidden = channel('private-case', { view: false, send: false });
  const g = guild(hidden);
  const record = {
    guildId: g.id,
    channelId: hidden.id,
    messageId: '100000000000000020',
    embedIndex: 0,
    source: 'embed-builder',
    snapshot: { title: 'Confidential case', description: 'Private data' },
  };

  assert.deepEqual(
    filterEmbedBuilderSearchRecords(g, member, [record], { requireSend: true }),
    [],
  );
});

test('Search keeps a catalog template but removes an inaccessible live preview attached to it', () => {
  const internal = channel('botlog', { view: false, send: false });
  const hidden = channel('private-runtime', { view: false, send: false });
  const g = guild(internal, hidden);

  const catalog = {
    guildId: g.id,
    channelId: internal.id,
    backingChannelId: internal.id,
    messageId: '100000000000000030',
    embedIndex: 0,
    source: 'system-catalog',
    snapshot: { title: 'Permission denied', description: 'You cannot use this action.' },
    previewRecord: {
      guildId: g.id,
      channelId: hidden.id,
      messageId: '100000000000000031',
      embedIndex: 0,
      source: 'cloudy',
      snapshot: { title: 'Permission denied', description: 'Sensitive runtime detail' },
    },
  };

  const [safe] = filterEmbedBuilderSearchRecords(g, member, [catalog], { requireSend: true });
  assert.ok(safe);
  assert.equal(safe.previewRecord, null);
  const matches = buildMatches(g, [safe], 'permission denied');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Permission denied');
});

test('autocomplete and execution use the complete Search loader, not the old strict backing-channel filter', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /async function loadEmbedBuilderSearchRecords\(interaction\)/);
  assert.match(source, /getFastCanonicalBuilderRecords\(interaction\.guild\)/);
  assert.match(source, /filterEmbedBuilderSearchRecords\(/);

  const autocompleteStart = source.indexOf('embedBuilderCommand.autocomplete');
  const executeStart = source.indexOf('const originalExecute', autocompleteStart);
  const autocomplete = source.slice(autocompleteStart, executeStart);
  assert.match(autocomplete, /await loadEmbedBuilderSearchRecords\(interaction\)/);
  assert.doesNotMatch(autocomplete, /filterEmbedBuilderRecords/);

  const execute = source.slice(executeStart);
  assert.match(execute, /await loadEmbedBuilderSearchRecords\(interaction\)/);
  assert.doesNotMatch(execute, /filterEmbedBuilderRecords/);
});
