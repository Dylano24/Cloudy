import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { repairWelcomeChannel, hasBrokenWelcomeFields } from '../src/events/welcomeFieldRepairReady.js';

// ONE-TIME REPAIR test: remove together with src/events/welcomeFieldRepairReady.js.
const BOT = 'cloudy-bot';
const intactFields = [
  { name: 'Rules', value: '[Check our rules](https://discord.com/channels/1/2)\n​', inline: false },
  { name: 'Support & Help', value: '[Contact us](https://discord.com/channels/1/3)', inline: false },
];
const brokenFields = [
  { name: '📜 Rules', value: '[Check our rules]({dynamic})\n\\u200b', inline: false },
  { name: '📩 Support & Help', value: '[Contact us]({dynamic})', inline: false },
];
const welcome = (n, fields) => ({
  title: 'Welcome to Cloudy Inc.',
  description: `You are the **${n}**th member of the server <@${n}00>`,
  fields,
  thumbnail: { url: 'https://example.com/logo.gif' },
  image: { url: 'https://example.com/banner.gif' },
  footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  color: 0xFFFFFF,
});

function fixture(t, specs) {
  t.mock.method(db, 'get', async (_key, fallback) => fallback ?? []);
  const edits = new Map();
  const messages = specs.map((spec, index) => {
    const message = {
      id: String(9000 - index), createdTimestamp: 9000 - index,
      author: { id: spec.author || BOT }, webhookId: null,
      interaction: null, interactionMetadata: spec.builder ? { id: 'i' } : null,
      embeds: [new Embed(spec.embed)],
      edit: async payload => {
        edits.set(message.id, payload);
        message.embeds = payload.embeds.map(data => new Embed(data));
        return message;
      },
    };
    return message;
  });
  const batch = new Map(messages.map(message => [message.id, message]));
  batch.last = () => messages.at(-1);
  const channel = {
    id: 'welcome-channel', name: 'welcome',
    messages: { fetch: async arg => (typeof arg === 'string' ? messages.find(m => m.id === arg) : batch) },
  };
  return { guild: { id: 'repair-guild', channels: { cache: new Map() } }, channel, messages, edits };
}

test('a broken welcome message gets the fields of the newest intact one; its text stays', async t => {
  const f = fixture(t, [
    { embed: welcome(9, brokenFields), builder: true }, // the Builder preview: never touched
    { embed: welcome(9, brokenFields) },
    { embed: welcome(8, intactFields) },
    { embed: welcome(7, intactFields.map(field => ({ ...field, value: 'older' }))) },
    { embed: { title: 'Something else', fields: brokenFields } },
  ]);
  const result = await repairWelcomeChannel(f.guild, f.channel, BOT);
  assert.deepEqual(result.repaired, [f.messages[1].id]);
  assert.deepEqual([...f.edits.keys()], [f.messages[1].id], 'only the broken welcome message is edited');
  const fixed = f.edits.get(f.messages[1].id).embeds[0];
  assert.deepEqual(fixed.fields, intactFields, 'fields of the newest intact welcome message');
  assert.equal(fixed.description, welcome(9, []).description, 'its own text stays');
  assert.equal(fixed.image.url, 'https://example.com/banner.gif');
  assert.equal(fixed.thumbnail.url, 'https://example.com/logo.gif');
  assert.equal(fixed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.equal(hasBrokenWelcomeFields(f.messages[1]), false);
  assert.equal(hasBrokenWelcomeFields(f.messages[0]), true, 'the Builder preview is left alone');
});

test('without an intact welcome message nothing is edited', async t => {
  const f = fixture(t, [{ embed: welcome(9, brokenFields) }]);
  const result = await repairWelcomeChannel(f.guild, f.channel, BOT);
  assert.deepEqual(result.repaired, []);
  assert.equal(f.edits.size, 0);
});
