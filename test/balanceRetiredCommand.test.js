import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getCanonicalBuilderRecords, loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { applyRuntimeEmbedTemplateData, getSystemEmbedTemplateKey, primeSystemEmbedTemplateData } from '../src/services/systemEmbedCatalogService.js';
import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { buildGamblingGuideDescription, removeRetiredGamblingGuideCommand, isRetiredGamblingCommand } from '../src/config/gamblingCommands.js';
import { isPlayerCommand } from '../src/config/playerCommands.js';
import { createStickyGuideManager } from '../src/services/stickyGuideService.js';
import { hydrateBuilderPreviewRecord } from '../src/services/builderRuntimePreviewService.js';

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

test('saving a legacy plain Balance master applies to every user and survives restart', async () => {
  const values = storage();
  const guild = { id: 'legacy-balance-save', client: { user: { id: 'bot' } }, channels: { cache: new Map() } };
  const snapshot = { title: 'Balance', description: 'Your balance', color: 0xFFFFFF,
    fields: [{ name: 'Cash', value: '${dynamic}', inline: true }],
    author: { name: 'Cloudy template key: source:balance-old || Cloudy context: gambling/balance || Cloudy kind: embed' } };
  const master = { guildId: guild.id, channelId: 'gambling', backingChannelId: 'catalog',
    messageId: 'master', embedIndex: 0, source: 'system-catalog', title: 'Balance', snapshot };
  const message = { id: 'master', guildId: guild.id, guild, channelId: 'catalog', author: { id: 'bot' },
    flags: { has: () => false }, embeds: [new Embed(snapshot)], createdAt: new Date() };
  message.edit = async payload => { message.embeds = payload.embeds.map(embed => new Embed(embed)); return message; };
  const channel = { id: 'catalog', name: 'catalog', type: 0, messages: { fetch: async () => message } };
  message.channel = channel;
  guild.channels.cache.set('catalog', channel);
  guild.channels.cache.set('gambling', { id: 'gambling', name: 'gambling', type: 0 });
  values.set(`cloudy:embed-registry:${guild.id}`, [master]);
  const [canonical] = await getCanonicalBuilderRecords(guild);
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, canonical, canonical.previewRecord, canonical.sourceRecord), true);
  state.title = 'balance'; state.sideColor = 0x123456;
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  for (const [user, amount] of [['Dylano', '$123'], ['feelfate', '$456']]) {
    const result = await applySavedResponsePayloadTemplates({ embeds: [{ title: `${user}'s Balance`, description: 'Your balance',
      fields: [{ name: 'Cash', value: amount, inline: true }] }] }, { guildId: guild.id, channelId: 'gambling', commandName: 'balance' });
    assert.equal(result.embeds[0].title, `${user}'s balance`);
    assert.equal(result.embeds[0].fields[0].value, amount);
    assert.equal(result.embeds[0].color, 0x123456);
  }
  const script = `const {db}=await import('./src/utils/database.js'); const values=new Map(JSON.parse(process.env.CLOUDY_TEST_VALUES));
    db.initialized=true; db.useFallback=false; db.db={get:async key=>values.get(key)??null};
    const {applySavedResponsePayloadTemplates}=await import('./src/events/fullResponseCatalogReady.js');
    const out=await applySavedResponsePayloadTemplates({embeds:[{title:"NewUser's Balance",fields:[{name:'Cash',value:'$789',inline:true}]}]},
      {guildId:'legacy-balance-save',channelId:'gambling'}); console.log('RESULT:'+JSON.stringify(out));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLOUDY_TEST_VALUES: JSON.stringify([...values]) },
  });
  const restored = JSON.parse(output.split('RESULT:')[1]);
  assert.equal(restored.embeds[0].title, "NewUser's balance");
  assert.equal(restored.embeds[0].fields[0].value, '$789');
});

test('catalog title decoration preserves the Balance member prefix before the saved-template pass', () => {
  const context = 'gambling/balance';
  const description = 'Here is the current financial status for Dylano.';
  const key = getSystemEmbedTemplateKey('embed', "Dylano's Balance", description, context);
  primeSystemEmbedTemplateData(key, context, { title: 'balance', color: 0xFFFFFF });
  for (const name of ['Dylano', 'feelfate']) {
    const result = applyRuntimeEmbedTemplateData({ title: `${name}'s Balance`, description }, { commandName: 'balance' });
    assert.equal(result.title, `${name}'s balance`);
  }
});

test('retired command is absent from code discovery, player commands, guide and Builder', async () => {
  storage();
  assert.equal(fs.existsSync('src/commands/Economy/slut.js'), false);
  assert.equal(isPlayerCommand('slut'), false);
  assert.equal(isRetiredGamblingCommand('slut'), true);
  assert.doesNotMatch(buildGamblingGuideDescription(), /\/slut\b/);
  const definitions = await discoverEmbedDefinitions();
  assert.equal(definitions.some(definition => definition.context === 'gambling/slut'), false);
  const guild = { id: 'retired-builder', channels: { cache: new Map() } };
  const record = { channelId: 'gambling', messageId: 'retired', source: 'system-catalog', snapshot: {
    title: 'Reward', description: 'Old reward',
    author: { name: 'Cloudy template key: old || Cloudy context: gambling/slut || Cloudy kind: embed' },
  } };
  assert.equal((await getCanonicalBuilderRecords(guild, [record])).length, 0);
});

test('existing guide removes only the retired command line and preserves custom text and styling', async () => {
  const values = storage();
  const guide = { title: 'Gambling & Games', color: 0x123456, description:
    'My introduction\n\n**Earn money**\n`/slut` — old text\n`/work` — my text\n\nMy ending',
    footer: { text: 'My footer' }, thumbnail: { url: 'https://example.com/logo.png' } };
  const expected = { ...guide, description: 'My introduction\n\n**Earn money**\n`/work` — my text\n\nMy ending' };
  assert.deepEqual(removeRetiredGamblingGuideCommand(guide), expected);
  const result = await applySavedResponsePayloadTemplates({ embeds: [guide] }, { guildId: 'retired-guide', channelId: 'gambling' });
  assert.deepEqual(result.embeds[0], expected);
  values.set('cloudy:builder-runtime-preview:retired-guide:gambling:gambling games', guide);
  const preview = await hydrateBuilderPreviewRecord({ id: 'retired-guide' },
    { channelId: 'gambling', snapshot: guide }, null, 'user');
  assert.deepEqual(preview.snapshot, expected);
  assert.deepEqual(removeRetiredGamblingGuideCommand({ ...guide, title: 'ZORP Guide' }), { ...guide, title: 'ZORP Guide' });
});

test('a guide already at the bottom is sanitized without reposting it or repeated edits', async () => {
  let edits = 0;
  const message = { id: 'guide', author: { id: 'bot' }, embeds: [new Embed({ title: 'Gambling & Games',
    description: 'Custom intro\n`/slut` — old text\n`/work` — preserved text', color: 0x123456 })] };
  message.edit = async ({ embeds }) => { edits++; message.embeds = embeds.map(embed => new Embed(embed)); return message; };
  const recent = new Map([[message.id, message]]); recent.first = () => message;
  const channel = { id: 'channel', client: { user: { id: 'bot' } }, lastMessageId: message.id,
    messages: { fetch: async () => recent }, send: async () => { throw new Error('Must not repost'); } };
  const manager = createStickyGuideManager({ loadState: async () => ({ messageId: message.id }), saveState: async () => true,
    isGuide: () => true, onError: error => { throw error; }, buildPayload: async () => { throw new Error('Must not build'); },
    prepareExisting: async existing => {
      const original = existing.embeds.map(embed => embed.toJSON());
      const embeds = original.map(removeRetiredGamblingGuideCommand);
      return JSON.stringify(embeds) === JSON.stringify(original) ? existing : existing.edit({ embeds });
    },
  });
  assert.equal(await manager.refresh(channel), true);
  assert.equal(await manager.refresh(channel), true);
  assert.equal(edits, 1);
  assert.equal(message.embeds[0].description, 'Custom intro\n`/work` — preserved text');
  assert.equal(message.embeds[0].color, 0x123456);
});
