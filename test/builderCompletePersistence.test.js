import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration, getCachedSavedEmbedTemplateData } from '../src/services/embedTemplateService.js';
import { handleAddCurrency, handleRemoveCurrency } from '../src/commands/Economy/modules/economy_dashboard.js';
import { addMoney, getEconomyData } from '../src/utils/economy.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

const stored = new Map();
db.initialized = true;
db.useFallback = false;
db.db = { get: async key => stored.get(key), set: async (key, value) => { stored.set(key, structuredClone(value)); return true; } };

test('discovery excludes modal titles and retains all embed fields and footer', () => {
  const source = `const modal = new ModalBuilder().setTitle('Add Currency');
    const embed = new EmbedBuilder().setTitle('Add currency')
      .setDescription('Full message').addFields(
        { name: 'Account', value: 'Wallet', inline: true },
        { name: 'Balance', value: '100', inline: false }
      ).setFooter({ text: 'Saved footer' });`;
  const entries = extractDefinitions(source, 'commands/Economy/test.js').filter(item => item.kind === 'embed');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Add currency');
  assert.deepEqual(entries[0].fields, [{ name: 'Account', value: 'Wallet', inline: true }, { name: 'Balance', value: '100', inline: false }]);
  assert.equal(entries[0].footer.text, 'Saved footer');
});

test('a new Save retains edited fields, footer and media and honors explicit removals', async () => {
  const guild = 'full-save', channel = 'channel';
  const edited = { title: 'Add currency', description: 'My complete text', color: 123,
    fields: [{ name: 'Edited field', value: 'My value', inline: true }], footer: { text: 'My footer' },
    thumbnail: { url: 'https://example.com/logo.png' }, image: { url: 'https://example.com/image.png' } };
  await saveEmbedTemplateDecoration(guild, channel, ['Currency Added'], edited, { applyThumbnail: true, applyImage: true });
  const result = getCachedSavedEmbedTemplateData(guild, channel, { ...edited, title: 'Currency Added', description: 'Old text', fields: [{ name: 'Old field', value: 'Old value' }] });
  assert.deepEqual(result.data, edited);
  await saveEmbedTemplateDecoration(guild, channel, ['Currency Added'], { title: 'Add currency', description: '', fields: [], color: 123 }, { applyThumbnail: true, applyImage: true });
  const cleared = getCachedSavedEmbedTemplateData(guild, channel, { ...edited, title: 'Currency Added' }).data;
  for (const key of ['description', 'fields', 'footer', 'thumbnail', 'image']) assert.equal(cleared[key], undefined);
});

function modalContext(type = 'wallet') {
  const calls = [];
  const submitted = { user: { id: 'admin' }, guildId: '1532882647838228723', channelId: 'c',
    fields: { getField: () => ({ values: ['1532882647838228724'] }), getTextInputValue: key => key === 'amount' ? '10' : type },
    deferReply: async () => { submitted.deferred = true; calls.push('defer'); },
    editReply: async payload => { calls.push(payload); submitted.replied = true; return { id: 'reply' }; },
    deleteReply: async () => {} };
  const select = { user: submitted.user, showModal: async () => {}, awaitModalSubmit: async () => submitted };
  const client = { db: { get: async () => { assert.equal(calls[0], 'defer'); return { wallet: 100, bank: 100 }; }, set: async () => true, list: async () => [] } };
  const guild = { id: '1532882647838228723', name: 'Cloudy', members: { cache: new Map(), fetch: async () => { assert.equal(calls[0], 'defer'); return { user: { bot: false, tag: 'Member' } }; } } };
  return { calls, submitted, select, client, guild };
}

test('Add and Remove Currency acknowledge before I/O and reply on the submitted form', async () => {
  const original = InteractionHelper.safeEditReply;
  InteractionHelper.safeEditReply = async () => {};
  try {
    for (const [handler, title] of [[handleAddCurrency, 'Add currency'], [handleRemoveCurrency, 'Remove currency']]) {
      const c = modalContext();
      await handler(c.select, {}, c.guild, c.client);
      assert.equal(c.calls[0], 'defer');
      assert.equal(c.calls[1].embeds[0].toJSON().title, title);
    }
  } finally { InteractionHelper.safeEditReply = original; }
});

test('economy database failure cannot produce a success or overwrite a default account', async () => {
  let writes = 0;
  await assert.rejects(getEconomyData({ db: { get: async () => { throw new Error('offline'); } } }, '1532882647838228723', '1532882647838228724'));
  await assert.rejects(addMoney({ db: { get: async () => ({ wallet: 10 }), set: async () => { writes++; return false; } } }, '1532882647838228723', '1532882647838228724', 10));
  assert.equal(writes, 1);
});
