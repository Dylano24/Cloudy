import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, isRegistrableCloudyEmbedMessage, registerCloudyEmbedMessage } from '../src/services/embedRegistryService.js';
import { getCanonicalBuilderRecords, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { applySavedEmbedTemplates } from '../src/services/embedTemplateService.js';

test('complete existing ZORP guide loads through registry and canonical builder without automatic edits', async () => {
  const values = new Map();
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  db.db = { get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key), list: async () => [] };
  const guild = { id: '1532882647838228723', client: { user: { id: 'bot' } }, channels: { cache: new Collection() } };
  let fetches = 0;
  const channel = { id: '1554538634898710654', name: 'zorp-off-raid-protection', type: 0,
    toString: () => '<#1554538634898710654>', messages: { fetch: async id => {
      fetches += 1; assert.equal(id, '1554543233047199787'); return message;
    } } };
  guild.channels.cache.set(channel.id, channel);
  const data = { title: '<:cloudy_terms_icon:1540000000000000000> ZORP Guide', description: 'Original guide introduction.',
    color: 0xFFFFFF, fields: [{ name: 'How to claim a ZORP zone', value: '• Be part of a team.\n• Be the Team Leader.', inline: false },
      { name: 'Zone colors', value: '<:cloudy_zorp_white:1540291602336059432> **White**', inline: false }],
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } };
  let edits = 0;
  const message = { id: '1554543233047199787', guildId: guild.id, channelId: channel.id, guild, channel,
    author: guild.client.user, embeds: [new Embed(data)], flags: { has: () => false }, editable: true,
    edit: async () => { edits += 1; } };
  assert.equal(isRegistrableCloudyEmbedMessage(message), true);
  const discovered = await getCanonicalBuilderRecords(guild);
  assert.equal(discovered.length, 1); assert.equal(fetches, 1);
  await registerCloudyEmbedMessage(message);
  const registry = await getEmbedRegistry(guild.id);
  assert.equal(registry.length, 1); assert.deepEqual(registry[0].snapshot, data);
  const records = await getCanonicalBuilderRecords(guild, registry);
  assert.equal(records.length, 1);
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, records[0], records[0].previewRecord, records[0].sourceRecord), true);
  assert.deepEqual(state.embedFields, data.fields); assert.equal(state.message, data.description);
  await applySavedEmbedTemplates(message);
  assert.equal(edits, 0);
  assert.equal(isRegistrableCloudyEmbedMessage({ ...message, embeds: [new Embed({ title: 'Random helper' })] }), false);
  assert.equal(isRegistrableCloudyEmbedMessage({ ...message, flags: { has: flag => flag === MessageFlags.Ephemeral } }), false);
});
