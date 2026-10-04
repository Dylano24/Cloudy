import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { db } from '../src/utils/database.js';
import { Embed } from 'discord.js';
import { getCanonicalBuilderRecords, buildEmbedPayload, loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { primeSystemSourceDefinitionPreview } from '../src/services/systemEmbedCatalogService.js';
import { saveEmbedTemplateDecoration, decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { resolveResponseMessage, shouldUseTransientTimer, installInteractionMessageLifecycle } from '../src/utils/interactionMessageLifecycle.js';
import { isTransientStatusPayload, rememberTransientPayloadIntent } from '../src/utils/transientResponse.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

function storage() {
  const values = new Map();
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  db.db = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return values;
}
function record(guildId, channelId, id, title, context, key = `source:${id}`, description = 'Complete response body') {
  const snapshot = { title, description, color: 0xFFFFFF,
    author: { name: `Cloudy template key: ${key} || Cloudy context: ${context} || Cloudy kind: embed` } };
  primeSystemSourceDefinitionPreview({ kind: 'embed', key, title, description, context });
  return { guildId, channelId, backingChannelId: 'catalog', messageId: id, embedIndex: 0,
    source: 'system-catalog', title, name: title, snapshot, createdAt: new Date().toISOString() };
}
function guild(id, names) {
  return { id, client: { user: { id: 'bot' } }, channels: { cache: new Map(names.map(name => [name, {
    id: name, name, type: 0, messages: { fetch: async () => null }, toString: () => `<#${name}>`,
  }])) } };
}
function options(payload) {
  return payload.components.flatMap(row => row.toJSON().components).flatMap(item => item.options || []);
}

test('all feature families are visible before Search/Save and both entry points open the same master', async () => {
  const values = storage();
  const g = guild('all-feature-families', ['gambling', 'tickets', 'welcome', 'botlog', 'join-create', 'verification', 'commands']);
  const examples = [
    ['gambling', 'Balance', 'gambling/balance'], ['gambling', 'Too fast', 'gambling/work'],
    ['gambling', 'Insufficient funds', 'gambling/beg'], ['tickets', 'Ticket claim failed', 'tickets/claim'],
    ['welcome', 'Welcome to Cloudy Inc.', 'welcome/greet'], ['botlog', 'Timeout log', 'botlog/timeout'],
    ['botlog', 'Automod timeout', 'botlog/automod'], ['join-create', 'Join to create configuration', 'join-to-create/dashboard'],
    ['verification', 'Verification', 'verification/panel'], ['commands', 'Ping', 'utility/ping'],
    ['commands', 'Invalid input', 'utility/error'], ['commands', 'Warning', 'utility/warning'],
    ['commands', 'Information', 'utility/info'],
  ];
  const records = examples.map(([channel, title, context], i) => record(g.id, channel, `row-${i}`, title, context));
  values.set(`cloudy:embed-registry:${g.id}`, records);
  let writes = 0;
  const set = db.db.set; db.db.set = async (...args) => { writes++; return set(...args); };
  const canonical = await getCanonicalBuilderRecords(g);
  assert.equal(canonical.length, examples.length);
  for (const [channel, title] of examples) {
    const found = buildMatches(g, canonical, title).find(match => match.record.channelId === channel && match.record.title === title);
    assert.ok(found, title);
    assert.ok(options(buildEmbedPayload(g, canonical, channel)).some(option => option.value === `${found.record.messageId}:0`), title);
    const state = {};
    assert.equal(loadRecordSnapshotIntoState(state, g, found.record, found.record.previewRecord, found.record.sourceRecord), true);
    assert.equal(state.message, 'Complete response body');
  }
  assert.equal(writes, 0);
});

test('stale aliases, runtime members and channels collapse to one canonical Balance/Too fast', async () => {
  storage();
  const g = guild('duplicate-family-flow', ['gambling', 'other']);
  const records = [
    record(g.id, 'gambling', 'balance-master', "{dynamic}'s Balance", 'gambling/balance'),
    record(g.id, 'other', 'balance-old', "Dylano's Balance", 'gambling/balance'),
    record(g.id, 'gambling', 'fast-master', 'Too fast', 'gambling/beg'),
    record(g.id, 'other', 'fast-old', 'Too fast', 'gambling/work'),
  ];
  const view = await getCanonicalBuilderRecords(g, records);
  assert.equal(view.length, 2);
  assert.equal(buildMatches(g, view, 'balance').length, 1);
  assert.equal(buildMatches(g, view, 'too fast').length, 1);
});

test('channel browser retains one Content Creators guide in every platform while Search keeps one master', async () => {
  storage();
  const g = guild('guide-channel-dedup', ['botlog', 'youtube', 'twitch', 'tiktok']);
  const master = record(g.id, 'botlog', 'guide-master', '🎥 Content Creators', 'botlog/content-creator-guide-service');
  const records = [master];
  for (const platform of ['youtube', 'twitch', 'tiktok']) {
    for (const id of ['old', 'latest']) records.push({ guildId: g.id, channelId: platform, messageId: `${platform}-${id}`, embedIndex: 0, source: 'content-creators', snapshot: { title: '🎥 Content Creators', description: 'Subscribe to publish your content.', color: 0xFFFFFF } });
  }
  const canonical = await getCanonicalBuilderRecords(g, records, { perChannel: true });
  for (const platform of ['youtube', 'twitch', 'tiktok']) {
    assert.equal(canonical.filter(r => r.channelId === platform).length, 1);
    const rows = options(buildEmbedPayload(g, canonical, platform));
    assert.equal(rows.length, 1);
    const selected = canonical.find(r => r.channelId === platform);
    const state = {};
    assert.equal(loadRecordSnapshotIntoState(state, g, selected, selected.previewRecord, selected.sourceRecord), true);
    assert.equal(state.modifyTarget.channelId, platform);
    assert.equal(state.message, 'Subscribe to publish your content.');
  }
  const search = await getCanonicalBuilderRecords(g, records);
  assert.equal(search.length, 1);
  assert.equal(buildMatches(g, search, 'Content Creators').length, 1);
});

test('Save through a canonical master persists repeated edits, media removals and styling across a fresh process', async () => {
  const values = storage();
  const g = guild('durable-canonical-save', ['commands', 'catalog']);
  const master = record(g.id, 'commands', 'information-master', 'Server details', 'utility/details');
  const message = { id: master.messageId, guildId: g.id, guild: g, channelId: 'catalog', author: { id: 'bot' },
    flags: { has: () => false }, embeds: [new Embed(master.snapshot)], createdAt: new Date() };
  message.edit = async payload => { message.embeds = payload.embeds.map(embed => new Embed(embed)); return message; };
  const channel = g.channels.cache.get('catalog'); channel.messages.fetch = async () => message; message.channel = channel;
  values.set(`cloudy:embed-registry:${g.id}`, [master]);
  let [canonical] = await getCanonicalBuilderRecords(g);
  const state = {};
  loadRecordSnapshotIntoState(state, g, canonical, canonical.previewRecord, canonical.sourceRecord);
  state.title = 'server details'; state.message = 'Saved fixed body'; state.sideColor = 0x7A1712;
  state.embedFields = [{ name: 'Custom field', value: 'Custom content', inline: true }];
  state.bottomLine = 'Custom footer'; state.mediaUrl = 'https://example.com/saved.png';
  assert.equal((await saveModifiedEmbed(g, state)).ok, true);
  [canonical] = await getCanonicalBuilderRecords(g);
  assert.equal(canonical.snapshot.description, 'Saved fixed body');
  assert.equal(canonical.snapshot.color, 0x7A1712);
  assert.equal(canonical.snapshot.image.url, state.mediaUrl);
  const reopened = {};
  loadRecordSnapshotIntoState(reopened, g, canonical, canonical.previewRecord, canonical.sourceRecord);
  reopened.title = 'Server overview';
  assert.equal((await saveModifiedEmbed(g, reopened)).ok, true);
  let output = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Server details', description: 'Old source body', color: 0x123456 }] }, { guildId: g.id, channelId: 'other-command-channel' });
  assert.equal(output.embeds[0].title, 'Server overview');
  assert.equal(output.embeds[0].description, 'Saved fixed body');
  assert.equal(output.embeds[0].fields[0].value, 'Custom content');
  assert.equal(output.embeds[0].image.url, 'https://example.com/saved.png');
  assert.equal(output.embeds[0].footer.text, 'Custom footer');
  reopened.mediaUrl = null; reopened.embedFields = []; reopened.bottomLine = null; reopened.message = null;
  assert.equal((await saveModifiedEmbed(g, reopened)).ok, true);
  output = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Server details', description: 'Older source body', fields: [{ name: 'old', value: 'old' }], image: { url: 'https://example.com/old.png' } }] }, { guildId: g.id, channelId: 'other-command-channel' });
  for (const property of ['description', 'fields', 'image', 'footer']) assert.equal(output.embeds[0][property], undefined, property);
  const fresh = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { db } = await import('./src/utils/database.js');
    const values = new Map(JSON.parse(process.env.CLOUDY_TEST_VALUES));
    db.initialized = true; db.useFallback = false; db.db = { get: async k => values.get(k) ?? null };
    const { applySavedResponsePayloadTemplates } = await import('./src/events/fullResponseCatalogReady.js');
    const result = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Server details', description: 'Stale deploy source', fields: [{name:'old',value:'old'}] }] }, {guildId:'durable-canonical-save',channelId:'new-channel'});
    console.log('RESULT:' + JSON.stringify(result.embeds[0]));
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLOUDY_TEST_VALUES: JSON.stringify([...values]) } });
  const restored = JSON.parse(fresh.split('RESULT:')[1].trim());
  assert.equal(restored.title, 'Server overview');
  assert.equal(restored.color, 0x7A1712);
  assert.equal(restored.description, undefined);
  assert.equal(restored.fields, undefined);
  assert.equal((await getCanonicalBuilderRecords(g)).length, 1);
});

test('one Balance save keeps usernames dynamic and Too fast preserves the actual action body', async () => {
  storage();
  await saveEmbedTemplateDecoration('dynamic-canonical', 'gambling', ["{dynamic}'s Balance", 'Balance'], { title: 'balance', color: 0xFFFFFF }, { sharedScope: true });
  for (const user of ['Dylano', 'feelfate']) {
    const result = await decorateEmbedWithSavedTemplate('dynamic-canonical', 'another', { title: `${user}'s Balance`, description: '$123' });
    assert.equal(result.embed.toJSON().title, `${user}'s balance`);
  }
  await saveEmbedTemplateDecoration('dynamic-canonical', 'gambling', ['Too fast'], { title: 'too fast', description: 'Jail snapshot 10 minutes', color: 0x7A1712 }, { sharedScope: true });
  for (const description of ['Work cooldown: 7 minutes', 'Beg cooldown: 4 minutes', 'Jail: 2 minutes']) {
    const result = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Too fast', description }] }, { guildId: 'dynamic-canonical', channelId: 'another' });
    assert.equal(result.embeds[0].description, description);
    assert.equal(result.embeds[0].title, 'too fast');
  }
});

test('component replies and follow-ups resolve their own message instead of the permanent parent', async () => {
  const parent = { id: 'ticket-main' }, reply = { id: 'new-warning' };
  const interaction = { message: parent, fetchReply: async () => reply };
  assert.equal(await resolveResponseMessage(interaction, undefined, 'reply'), reply);
  assert.equal(await resolveResponseMessage(interaction, undefined, 'editReply'), reply);
  assert.equal(await resolveResponseMessage(interaction, undefined, 'update'), parent);
  assert.equal(await resolveResponseMessage(interaction, { resource: { message: reply } }, 'reply'), reply);
  assert.equal(await resolveResponseMessage(interaction, undefined, 'followUp'), null);
});

test('ten-second cleanup follows original status intent and protects mixed content, guides and catalog masters', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outgoing = rememberTransientPayloadIntent({ embeds: [{ title: 'Warning', description: 'Try again' }] }, { embeds: [{ title: 'Custom saved warning', description: 'Try again' }] });
  assert.equal(isTransientStatusPayload(outgoing), true);
  for (const permanent of [
    { id: 'guide', embeds: [{ title: 'ZORP Guide' }, { title: 'Warning' }] },
    { id: 'catalog', content: 'System & error embed templates', embeds: [{ title: 'Warning' }] },
    { id: 'log', channel: { name: 'ticket-logs' }, embeds: [{ title: 'Error' }] },
    { id: 'mixed', embeds: [{ title: 'Welcome' }, { title: 'Success' }] },
  ]) assert.equal(shouldUseTransientTimer(null, permanent), false);
});

test('a component follow-up is deleted at 10 seconds while its ticket parent remains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installInteractionMessageLifecycle();
  const deleted = [];
  const parent = { id: 'parent-ticket', embeds: [{ title: 'Ticket • #123' }] };
  const reply = { id: 'follow-up-warning', embeds: [{ title: 'Warning', description: 'Try again' }] };
  const interaction = {
    message: parent, webhook: { deleteMessage: async id => { deleted.push(id); } },
    fetchReply: async () => parent,
    followUp: async payload => { assert.equal(payload.fetchReply, true); return reply; },
  };
  InteractionHelper.patchInteractionResponses(interaction);
  await interaction.followUp({ embeds: reply.embeds });
  t.mock.timers.tick(9999); assert.deepEqual(deleted, []);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(deleted, [reply.id]);
});

test('edited ticket log labels keep each event’s current IDs and ticket values', async () => {
  storage();
  await saveEmbedTemplateDecoration('ticket-field-edit', 'ticket-logs', ['Ticket claimed'], {
    title: 'Ticket claimed', fields: [{ name: 'Ticket number', value: '#123' }, { name: 'Staff member', value: '<@123456789012345678>' }],
  }, { sharedScope: true, applyFields: true, preserveRuntimeFieldValues: true });
  const result = await decorateEmbedWithSavedTemplate('ticket-field-edit', 'ticket-logs', {
    title: 'Ticket claimed', fields: [{ name: 'Ticket', value: '#ticket-456' }, { name: 'Claimed by', value: '<@987654321098765432>' }],
  });
  assert.deepEqual(result.embed.toJSON().fields.map(field => [field.name, field.value]), [
    ['Ticket number', '#ticket-456'], ['Staff member', '<@987654321098765432>'],
  ]);
});

test('concurrent Saves within one millisecond retain the latest overlay until its write succeeds', async t => {
  storage();
  t.mock.method(Date.prototype, 'toISOString', () => '2026-10-03T00:00:00.000Z');
  let releaseFirst, releaseSecond, firstStarted, secondStarted;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const firstWriting = new Promise(resolve => { firstStarted = resolve; });
  const secondWriting = new Promise(resolve => { secondStarted = resolve; });
  const set = db.db.set;
  let writes = 0;
  db.db.set = async (...args) => {
    writes++;
    if (writes === 1) { firstStarted(); await firstGate; }
    else { secondStarted(); await secondGate; }
    return set(...args);
  };
  const options = { sharedScope: true, canonicalIdentity: 'concurrent-response' };
  const first = saveEmbedTemplateDecoration('concurrent-canonical', 'commands', ['Original response'], { title: 'First edit', description: 'First body' }, options);
  await firstWriting;
  const second = saveEmbedTemplateDecoration('concurrent-canonical', 'commands', ['Original response'], { title: 'Second edit', description: 'Second body' }, options);
  releaseFirst(); await first; await secondWriting;
  const duringWrite = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Original response', description: 'Old body' }] }, { guildId: 'concurrent-canonical', channelId: 'commands' });
  assert.equal(duringWrite.embeds[0].title, 'Second edit');
  assert.equal(duringWrite.embeds[0].description, 'Second body');
  releaseSecond(); assert.equal(await second, true);
});

