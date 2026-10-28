import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import {
    getEmbedRegistry, peekEmbedRegistry,
} from '../src/services/embedRegistryService.js';
import { refreshManualBuilderSearchRecord } from '../src/services/embedBuilderPhysicalSearchService.js';
import { buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';

function fixture(t, guildId, { unavailable = false } = {}) {
    const channelId = '177777777777777771';
    const messageId = '177777777777777772';
    const differentId = '177777777777777773';
    const messageBody = 'Same manually edited text and GIF';
    const old = {
        title: 'Test', description: messageBody, color: 0xffffff,
        thumbnail: { url: 'https://example.com/white-c.png' },
        image: { url: 'https://example.com/banner.gif' },
    };
    const latest = {
        ...old, title: 'Yess', color: 0xff0080,
        thumbnail: { url: 'https://example.com/dark-c.png' },
    };
    const record = {
        guildId, channelId, messageId, embedIndex: 0,
        source: 'embed-builder', manualSaved: true,
        title: old.title, name: old.title, snapshot: old, components: [],
    };
    // A separate physical post with its own title must remain untouched.
    const distinct = {
        ...record, messageId: differentId, title: 'Different saved post',
        name: 'Different saved post',
        snapshot: { title: 'Different saved post', description: 'Other content' },
    };
    const data = new Map([['cloudy:embed-registry:' + guildId, [record, distinct]]]);
    t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
    t.mock.method(db, 'set', async (key, value) => {
        data.set(key, structuredClone(value));
        return true;
    });
    let reads = 0;
    const channel = {
        id: channelId, name: 'general', guildId,
        permissionsFor: () => ({ has: () => true }),
        messages: { fetch: async (id, opts) => {
            assert.ok([messageId, differentId].includes(id));
            assert.equal(opts?.force, true);
            reads++;
            if (unavailable) throw new Error('Temporary Discord outage');
            return id === differentId ? physicalDistinct : physical;
        }},
    };
    const guild = { id: guildId, client: { user: { id: 'cloudy' } },
        channels: { cache: new Collection([[channelId, channel]]) },
    };
    const physical = {
        id: messageId, channelId, guildId, guild, channel,
        author: { id: 'cloudy' }, client: guild.client,
        embeds: [new Embed(latest)], components: [],
        createdAt: new Date('2026-10-28T08:47:00Z'),
    };
    const physicalDistinct = {
        ...physical, id: differentId,
        embeds: [new Embed(distinct.snapshot)],
    };
    return { guild, record, messageId, differentId, reads: () => reads, old, latest };
}

test('search resolves stale Test to the same physical Yess embed with correct color, logo and GIF', async t => {
    const f = fixture(t, 'search-physical-yess-parity-20261028');
    const records = await getEmbedRegistry(f.guild.id);
    const stale = records.find(x => x.messageId === f.messageId);
    assert.equal(stale.snapshot.title, 'Test');
    const updated = await refreshManualBuilderSearchRecord(f.guild, stale);
    assert.equal(updated.messageId, f.messageId);
    assert.equal(updated.snapshot.title, 'Yess');
    assert.equal(updated.snapshot.color, 0xff0080);
    assert.equal(updated.snapshot.thumbnail.url, 'https://example.com/dark-c.png');
    assert.equal(updated.snapshot.image.url, 'https://example.com/banner.gif');
    assert.equal(f.reads(), 1);
    const saved = await getEmbedRegistry(f.guild.id);
    const physical = saved.find(x => x.messageId === f.messageId);
    assert.equal(physical.snapshot.title, 'Yess');
    assert.equal(saved.find(x => x.messageId === f.differentId).snapshot.title, 'Different saved post');
    assert.ok(buildSearchChoices(buildMatches(f.guild, saved, 'Test'))
        .every(choice => choice.name !== 'Test'),
        'the stale title must never appear as a Search choice, even if text matches other fields');
    assert.deepEqual(buildSearchChoices(buildMatches(f.guild, saved, 'Yess')).map(c => c.name), ['Yess']);
    const state = {};
    assert.equal(loadRecordSnapshotIntoState(state, f.guild, physical), true);
    assert.equal(state.title, 'Yess');
    assert.equal(state.sideColor, 0xff0080);
    assert.equal(state.modifyTarget.sourceEmbedData.thumbnail.url, 'https://example.com/dark-c.png');
});

test('no registry deletion or phantom overwrite when the exact Discord message cannot be fetched', async t => {
    const f = fixture(t, 'physical-search-temporary-unavailable', { unavailable: true });
    const records = await getEmbedRegistry(f.guild.id);
    const record = records.find(x => x.messageId === f.messageId);
    t.mock.method(db, 'set', async () => assert.fail('temporary fetch failure must never delete or persist stale content'));
    const result = await refreshManualBuilderSearchRecord(f.guild, record);
    assert.equal(result, record);
    assert.equal(result.snapshot.title, 'Test');
    assert.equal(f.reads(), 1);
});

test('a different posted message ID is not collapsed just because its body matches another post', async t => {
    const f = fixture(t, 'physical-search-separate-identities');
    const records = await getEmbedRegistry(f.guild.id);
    const distinct = records.find(x => x.messageId === f.differentId);
    const returned = await refreshManualBuilderSearchRecord(f.guild, distinct);
    assert.equal(returned, distinct);
    assert.equal(returned.messageId, f.differentId);
});
