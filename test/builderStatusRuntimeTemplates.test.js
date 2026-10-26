import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../src/utils/database.js';
import fullResponseCatalog, { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { markBotResponsePayload, isBotResponsePayload } from '../src/utils/botResponseIntent.js';
import { isTransientStatusPayload } from '../src/utils/transientResponse.js';

fullResponseCatalog.execute({ on() {} });

function fixture(t, name) {
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  const source = { guildId: 'builder-status-' + name, channelId: '123456789012345691', customId: 'simple_embed_post' };
  const sent = [];
  const interaction = { ...source, id: 'interaction-' + name, createdTimestamp: Date.now(), user: { id: 'owner' },
    async reply(payload) { sent.push(payload); }, async editReply(payload) { sent.push(payload); },
    async followUp(payload) { sent.push(payload); }, async update(payload) { sent.push(payload); } };
  InteractionHelper.patchInteractionResponses(interaction);
  return { storage, source, interaction, sent };
}

for (const title of ['Removed from Builder', 'Changes saved', 'Permission denied', 'Could not save changes', 'Video conversion failed', 'Message sent']) {
  test(`saved ${title} response reaches the Builder interaction with exact owner content`, async t => {
    const f = fixture(t, title);
    const saved = { title: title + ' owner 2 🔨 <:cloudy:123456789012345678>', description: 'Owner saved response',
      color: 0x123456, footer: { text: 'Owner footer' }, fields: [{ name: 'Owner field', value: 'Saved value', inline: true }] };
    await saveEmbedTemplateDecoration(f.source.guildId, 'catalog-channel', [title], saved, {
      sharedScope: true,
      staticSourceData: { title, description: 'Default bot response',
        author: { name: 'Cloudy template key: source:status-fixture || Cloudy context: embed-builder/status || Cloudy kind: embed' } },
    });
    const payload = markBotResponsePayload({
      embeds: [new EmbedBuilder({ title, description: 'Default bot response', color: 0xffffff })],
      flags: MessageFlags.Ephemeral, components: [], fetchReply: true,
    });
    await f.interaction.followUp(payload);
    assert.equal(f.sent[0].embeds[0].title, saved.title);
    assert.equal(f.sent[0].embeds[0].description, saved.description);
    assert.deepEqual(f.sent[0].embeds[0].fields, saved.fields);
    assert.equal(f.sent[0].embeds[0].color, saved.color);
    assert.deepEqual(f.sent[0].embeds[0].footer, saved.footer);
    assert.equal(f.sent[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.sent[0].components, []);
    assert.ok(!JSON.stringify(f.sent[0]).includes('botResponseIntent'), 'no internal intent is sent to Discord');
    if (title === 'Removed from Builder') assert.equal(isTransientStatusPayload(f.sent[0]), true);
  });
}

test('every interaction response method uses saved bot status templates while identical preview content stays untouched', async t => {
  const f = fixture(t, 'all-methods');
  await saveEmbedTemplateDecoration(f.source.guildId, 'catalog-channel', ['Removed from Builder'], {
    title: 'Owner notice 🔨', description: 'Saved contents', color: 0x123456,
  }, { sharedScope: true });
  for (const method of ['reply', 'editReply', 'followUp', 'update']) {
    const preview = { embeds: [new EmbedBuilder({ title: 'Removed from Builder', description: 'Unsaved owner preview' })], flags: MessageFlags.Ephemeral };
    await f.interaction[method](preview);
    assert.equal(f.sent.at(-1), preview, 'unmarked owner preview must bypass automatic templates');
    await f.interaction[method](markBotResponsePayload({ embeds: [new EmbedBuilder({ title: 'Removed from Builder' })] }));
    assert.equal(f.sent.at(-1).embeds[0].title, 'Owner notice 🔨');
  }
  const notice = markBotResponsePayload({ embeds: [new EmbedBuilder({ title: 'Removed from Builder' })] });
  const mixed = { embeds: [...notice.embeds, new EmbedBuilder({ title: 'Message builder' })] };
  assert.equal(isBotResponsePayload(mixed), false);
  assert.equal(await applySavedResponsePayloadTemplates(mixed, f.source), mixed);
});

test('unmodified Builder status replies keep their original defaults', async t => {
  const f = fixture(t, 'unchanged');
  const payload = markBotResponsePayload({ embeds: [new EmbedBuilder({ title: 'Removed from Builder', description: 'Current default', color: 0x57f287 })] });
  await f.interaction.followUp(payload);
  assert.equal(f.sent[0].embeds[0], payload.embeds[0]);
});

test('saved response title and emoji reach a Builder notification after a fresh process restart', async t => {
  const f = fixture(t, 'restart');
  const title = 'Removed by builder 🔨 <a:cloudy:123456789012345678>';
  await saveEmbedTemplateDecoration(f.source.guildId, 'catalog-channel', ['Removed from Builder'], {
    title, description: 'Saved before restart', color: 0x123456,
  }, { sharedScope: true });
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { db } from './src/utils/database.js';
    import event from './src/events/fullResponseCatalogReady.js';
    import { InteractionHelper } from './src/utils/interactionHelper.js';
    import { markBotResponsePayload } from './src/utils/botResponseIntent.js';
    const data = JSON.parse(readFileSync(0, 'utf8'));
    const stored = new Map(data.storage);
    db.get = async (key, fallback) => stored.get(key) ?? fallback;
    db.set = async () => true;
    event.execute({ on() {} });
    let sent;
    const interaction = { ...data.source, id: 'cold-status', user: {id:'owner'}, createdTimestamp: Date.now(),
      async reply(payload) {sent=payload;}, async editReply(payload) {sent=payload;}, async followUp(payload) {sent=payload;} };
    InteractionHelper.patchInteractionResponses(interaction);
    await interaction.followUp(markBotResponsePayload({embeds:[{title:'Removed from Builder',description:'Default'}]}));
    assert.equal(sent.embeds[0].title, data.title);
    assert.equal(sent.embeds[0].description, 'Saved before restart');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify({ storage: [...f.storage], source: f.source, title }), encoding: 'utf8', timeout: 10000,
  });
});
