import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Embed, Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { primeSystemSourceDefinitionPreview, getSystemEmbedTemplateKey } from '../src/services/systemEmbedCatalogService.js';
import { getCanonicalBuilderRecords, loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { hydrateBuilderPreviewRecord } from '../src/services/builderRuntimePreviewService.js';
import fullResponseCatalog from '../src/events/fullResponseCatalogReady.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import balance from '../src/commands/Economy/balance.js';
import { balanceResponseIdentity } from '../src/services/balanceResponseIdentity.js';

const definition = (await discoverEmbedDefinitions()).find(item => item.context === 'gambling/balance');
assert.ok(definition);
primeSystemSourceDefinitionPreview(definition);
fullResponseCatalog.execute({ on() {} });

function fixture(id) {
  const values = new Map();
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  db.db = { get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key), list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  const guild = { id, client: { user: { id: 'bot' }, db: db.db }, channels: { cache: new Collection() } };
  const messages = new Map();
  for (const name of ['gambling', 'catalog']) guild.channels.cache.set(name, {
    id: name, name, type: 0, guild, messages: { fetch: async messageId => messages.get(messageId) ?? null },
  });
  const key = getSystemEmbedTemplateKey('embed', definition.title, definition.description, definition.context);
  function record(messageId, data, source = 'system-catalog') {
    const snapshot = { ...data, ...(source === 'system-catalog' ? {
      author: { name: `Cloudy template key: ${key} || Cloudy context: gambling/balance || Cloudy kind: embed` },
    } : {}) };
    const row = { guildId: guild.id, channelId: 'gambling', backingChannelId: 'catalog', messageId,
      embedIndex: 0, source, title: snapshot.title, snapshot };
    const message = { id: messageId, guildId: guild.id, guild, channelId: 'catalog',
      channel: guild.channels.cache.get('catalog'), author: { id: 'bot' }, flags: { has: () => false },
      embeds: [new Embed(snapshot)], createdAt: new Date() };
    message.edit = async payload => { message.embeds = payload.embeds.map(embed => new Embed(embed)); return message; };
    messages.set(messageId, message);
    return row;
  }
  const master = record('master', { ...definition, color: 0xFFFFFF });
  values.set(`cloudy:embed-registry:${guild.id}`, [master]);
  return { values, guild, master, record };
}

async function command(guild, name, amount) {
  const sent = [];
  const user = { id: name === 'Dylano' ? '123456789012345678' : '234567890123456789',
    username: name, tag: name, bot: false, displayAvatarURL: () => 'https://example.com/avatar.png' };
  const interaction = { id: `${Date.now()}`, guild, guildId: guild.id, channelId: 'gambling',
    channel: guild.channels.cache.get('gambling'), user, commandName: 'balance', createdTimestamp: Date.now(),
    isChatInputCommand: () => true, options: { getUser: () => null },
    deferred: false, replied: false, deferReply: async () => { interaction.deferred = true; },
    reply: async payload => { sent.push(payload); return { id: 'reply' }; },
    followUp: async payload => { sent.push(payload); return { id: 'reply' }; },
    editReply: async payload => { sent.push(payload); return { id: 'reply' }; },
  };
  InteractionHelper.patchInteractionResponses(interaction);
  const client = { db: { get: async () => ({ wallet: amount, bank: amount * 2 }) } };
  await balance.execute(interaction, {}, client);
  assert.equal(sent.length, 1);
  return sent[0].embeds[0]?.toJSON?.() || sent[0].embeds[0];
}

test('Search hides the legacy Success/Balance parser row and keeps one real command master', async () => {
  const f = fixture('345678901234567890');
  const legacy = f.record('legacy', { title: 'Success', description: 'Balance', color: 0x0000FF });
  // Historical parser records had a different title-derived key.
  legacy.snapshot.author.name = 'Cloudy template key: embed:old-balance || Cloudy context: gambling/balance || Cloudy kind: embed';
  f.values.set(`cloudy:embed-registry:${f.guild.id}`, [legacy, f.master]);
  const view = await getCanonicalBuilderRecords(f.guild);
  const matches = buildMatches(f.guild, view, 'balance');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, 'master');
});

test('actual Balance command uses Search Save and another Save cannot reset its capitalization', async () => {
  const f = fixture('456789012345678901');
  let view = await getCanonicalBuilderRecords(f.guild);
  let selected = buildMatches(f.guild, view, 'balance')[0].record;
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, f.guild, selected, selected.previewRecord, selected.sourceRecord), true);
  state.title = "{dynamic}'s balance";
  state.sideColor = 0x123456;
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  const savedView = await getCanonicalBuilderRecords(f.guild);
  assert.equal(savedView[0].snapshot.title, "{dynamic}'s balance");
  for (const [name, amount] of [['Dylano', 123], ['feelfate', 456]]) {
    const output = await command(f.guild, name, amount);
    assert.equal(output.title, `${name}'s balance`);
    assert.equal(output.color, 0x123456);
    assert.equal(output.fields[0].value, `$${amount}`);
    assert.equal(output.fields[1].value.startsWith(`$${amount * 2} /`), true);
  }
  view = await getCanonicalBuilderRecords(f.guild);
  selected = buildMatches(f.guild, view, 'balance')[0].record;
  const preview = await hydrateBuilderPreviewRecord(f.guild, selected, selected.previewRecord, '123456789012345678');
  const reopened = {};
  loadRecordSnapshotIntoState(reopened, f.guild, selected, preview, selected.sourceRecord);
  assert.match(reopened.title, /'s balance$/);
  reopened.sideColor = 0x654321;
  assert.equal((await saveModifiedEmbed(f.guild, reopened)).ok, true);
  const output = await command(f.guild, 'Dylano', 789);
  assert.equal(output.title, "Dylano's balance");
  assert.equal(output.color, 0x654321);
  const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {db}=await import('./src/utils/database.js'); const values=new Map(JSON.parse(process.env.CLOUDY_TEST_VALUES));
    db.initialized=true; db.useFallback=false; db.db={get:async key=>values.get(key)??null};
    const {InteractionHelper}=await import('./src/utils/interactionHelper.js');
    const {default:event}=await import('./src/events/fullResponseCatalogReady.js'); event.execute({on(){}});
    const {default:balance}=await import('./src/commands/Economy/balance.js');
    const user={id:'123456789012345678',username:'Dylano',tag:'Dylano',bot:false,displayAvatarURL:()=> 'https://example.com/avatar.png'};
    let result; const capture=async payload=>{result=payload.embeds[0]?.toJSON?.()||payload.embeds[0]; return {id:'reply'};};
    const interaction={id:'restart',guildId:'456789012345678901',channelId:'gambling',commandName:'balance',user,
      createdTimestamp:Date.now(),options:{getUser:()=>null},isChatInputCommand:()=>true,
      deferReply:async()=>{interaction.deferred=true},reply:capture,followUp:capture,editReply:capture};
    InteractionHelper.patchInteractionResponses(interaction);
    await balance.execute(interaction,{}, {db:{get:async()=>({wallet:999,bank:1998})}});
    console.log('RESULT:'+JSON.stringify(result));
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLOUDY_TEST_VALUES: JSON.stringify([...f.values]) } });
  const restored = JSON.parse(restarted.split('RESULT:')[1]);
  assert.equal(restored.title, "Dylano's balance");
  assert.equal(restored.fields[0].value, '$999');
  assert.equal(restored.color, 0x654321);
});

test('renaming the title keeps one master and the real command follows it', async () => {
  const f = fixture('567890123456789012');
  const [selected] = await getCanonicalBuilderRecords(f.guild);
  const state = {};
  loadRecordSnapshotIntoState(state, f.guild, selected, selected.previewRecord, selected.sourceRecord);
  state.title = "{dynamic}'s funds";
  state.embedFields[0].name = 'wallet';
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  const output = await command(f.guild, 'feelfate', 250);
  assert.equal(output.title, "feelfate's funds");
  assert.equal(output.fields[0].name, 'wallet');
  assert.equal(output.fields[0].value, '$250');
  const records = await getCanonicalBuilderRecords(f.guild);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.title, "{dynamic}'s funds");
  assert.equal(buildMatches(f.guild, records, 'balance').length, 1);
});

test('Balance errors never pick the account template, even when they include detail fields', () => {
  assert.equal(balanceResponseIdentity({ title: 'Error', fields: [{ name: 'Details', value: 'Invalid account' }] },
    { commandName: 'balance' }), null);
});

test('legacy capitalization is recovered but a new explicit uppercase Save remains authoritative', async () => {
  const f = fixture('678901234567890123');
  const legacy = { schemaVersion: 3, canonicalIdentity: 'balance', title: "{dynamic}'s Balance", color: 0x123456 };
  f.values.set(`cloudy:embed-template:${f.guild.id}:__global__`, { balance: legacy, "{dynamic}'s balance": legacy });
  const recovered = await command(f.guild, 'Dylano', 500);
  assert.equal(recovered.title, "Dylano's balance");
  assert.equal(recovered.color, 0x123456);
  const [selected] = await getCanonicalBuilderRecords(f.guild);
  const state = {};
  loadRecordSnapshotIntoState(state, f.guild, selected, selected.previewRecord, selected.sourceRecord);
  state.title = "{dynamic}'s Balance";
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  const output = await command(f.guild, 'feelfate', 600);
  assert.equal(output.title, "feelfate's Balance");
});
