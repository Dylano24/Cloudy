import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { registerAppealsApi } from '../src/web/appealsApi.js';
import { buildContentCreatorPayload, createContentCreatorGuideManager, CONTENT_CREATORS_TEXT, scheduleContentCreatorGuide } from '../src/services/contentCreatorGuideService.js';
import { buildCloudyPublicKnowledgeEvidence } from '../src/services/cloudyPublicKnowledgeService.js';
import { parseLatestPatch, repairEncodedPatchText } from '../src/services/rustPatchNotesService.js';
import { decodeHtmlEntities } from '../src/utils/decodeHtmlEntities.js';

test('news renders decimal, hexadecimal and named HTML entities as normal text', () => {
  const patch = parseLatestPatch('<rss><item><title>You and [&#8230;]</title><link>https://rust.facepunch.com/news/test</link><description><![CDATA[<p>You and &#x2026; &hellip; &amp; friends</p>]]></description></item></rss>');
  assert.equal(patch.title, 'You and […]');
  assert.equal(patch.body, 'You and … … & friends');
  assert.equal(decodeHtmlEntities('&#99999999; &#xD800;'), '&#99999999; &#xD800;');
});

test('content guide preserves supplied wording, uses camera and keeps custom text/buttons', () => {
  const payload = buildContentCreatorPayload();
  assert.equal(payload.embeds[0].toJSON().title, '🎥 Content Creators');
  assert.equal(payload.embeds[0].toJSON().description, CONTENT_CREATORS_TEXT);
  const custom = buildContentCreatorPayload({ embeds: [{ title: '🌐 Content Creators', description: 'Saved custom text', color: 123 }], components: [{ type: 1, components: [{ type: 2, style: 5, label: 'My link', url: 'https://example.com/' }] }] });
  assert.equal(custom.embeds[0].title, '🎥 Content Creators');
  assert.equal(custom.embeds[0].description, 'Saved custom text');
  assert.equal(custom.embeds[0].color, 123);
  assert.equal(custom.components[0].components[0].url, 'https://example.com/');
  assert.equal(scheduleContentCreatorGuide({ guild: {}, author: { bot: true }, channel: { name: '🎥│youtube' } }), false);
});

test('each single publication moves one preserved guide below it, across all three platforms and restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const platform of ['youtube', 'twitch', 'tiktok']) {
    let id = 100, state = null;
    const history = new Collection();
    const client = { user: { id: 'bot' }, db: { get: async () => state, set: async (_key, value) => { state = value; } } };
    const guild = { id: 'guild', client };
    const channel = { id: platform, name: `🎥│${platform}`, guild, client };
    const add = (author, embeds) => {
      const msg = { id: String(++id), author, embeds, guild, channel, async delete() { history.delete(this.id); } };
      history.set(msg.id, msg); channel.lastMessageId = msg.id; return msg;
    };
    channel.messages = { fetch: async options => options.message ? history.get(options.message) : new Collection([...history].reverse()) };
    channel.send = async payload => add(client.user, payload.embeds.map(embed => embed.toJSON ? embed.toJSON() : embed));
    let manager = createContentCreatorGuideManager();
    await manager.refresh(channel);
    for (let index = 0; index < 2; index++) {
      const human = add({ id: 'member' }, []);
      manager.schedule(human);
      t.mock.timers.tick(1500);
      await new Promise(resolve => { setImmediate(resolve); });
      assert.equal(history.has(human.id), true);
      assert.equal([...history.values()].filter(msg => msg.author.id === 'bot').length, 1);
      assert.equal(channel.lastMessageId, state.messageId);
      manager = createContentCreatorGuideManager();
    }
  }
});

test('FAQ discovers arbitrary current channels while excluding unreadable channels', async () => {
  const member = { id: 'member' }, bot = { id: 'bot' };
  const channels = new Collection();
  let privateRead = false;
  for (const [id, name, allowed] of [['new', '🎥│youtube', true], ['secret', 'staff-only', false]]) {
    channels.set(id, { id, name, type: 0, guildId: 'guild', isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => allowed }), messages: { fetch: async () => {
      if (!allowed) privateRead = true;
      return new Collection([['message', { id: 'message', content: 'YouTube subscription is €3/month', embeds: [], createdTimestamp: 1 }]]);
    } } });
  }
  const guild = { id: 'guild', channels: { cache: channels, fetch: async id => id ? null : channels }, members: { me: bot, fetch: async () => member } };
  const client = { channels: guild.channels };
  const result = await buildCloudyPublicKnowledgeEvidence({ client, guild, member, user: member }, { question: 'YouTube subscription' });
  const evidence = JSON.parse(result.text);
  assert.deepEqual(evidence.readableChannelDirectory, [{ channelId: 'new', channelName: '🎥│youtube' }]);
  assert.equal(evidence.readablePublicChannelMessages[0].channelId, 'new');
  assert.equal(privateRead, false);
});

test('website appeals deliver Discord and Rust forms to the current channel and retain long answers', async () => {
  let handler;
  const sent = [];
  const channel = { id: 'current', name: '📨│ban-timeout-appeals', type: 0, isTextBased: () => true, send: async payload => sent.push(payload) };
  const cache = new Collection([[channel.id, channel]]);
  const guild = { id: 'guild', channels: { cache, fetch: async () => cache } };
  const client = { isReady: () => true, channels: { cache, fetch: async () => null }, guilds: { cache: new Collection([['guild', guild]]) } };
  registerAppealsApi({ post: (_path, callback) => { handler = callback; } }, client);
  const submit = async (body, source = 'cloudy-store-appeal-v1') => {
    const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await handler({ body, get: () => source }, response); return response;
  };
  const body = { scope: 'discord', action: 'Ban', discordIdentity: 'member', gamertag: 'player', email: 'member@example.com', punishmentReason: 'a'.repeat(1000), punishmentJustified: 'b'.repeat(1000), acceptanceReason: 'c'.repeat(1000), futureChanges: 'd'.repeat(1000), evidence: 'e'.repeat(1000), additionalInfo: 'f'.repeat(1000) };
  assert.equal((await submit(body, 'wrong')).code, 403);
  assert.equal((await submit({ ...body, email: '' })).code, 400);
  for (const [scope, action] of [['discord', 'Ban'], ['rust', 'Ban'], ['discord', 'Mute']]) assert.equal((await submit({ ...body, scope, action })).code, 200);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].embeds[0].fields.every(field => field.value.length <= 500), true);
  assert.equal(JSON.parse(sent[0].files[0].attachment.toString()).futureChanges.length, 1000);
  assert.match(sent[1].embeds[0].title, /Rust server appeal/);
  assert.equal(sent[1].embeds[0].fields.find(field => field.name === 'Gamertag').value, 'player');
  for (const index of [0, 2]) {
    assert.equal(sent[index].embeds[0].fields.some(field => field.name === 'Gamertag'), false);
    assert.equal(Object.hasOwn(JSON.parse(sent[index].files[0].attachment.toString()), 'gamertag'), false);
  }
  for (const payload of sent) {
    assert.equal(payload.embeds[0].fields.some(field => field.name === 'What will you do differently if your appeal is accepted?'), true);
    assert.equal(payload.embeds[0].fields.some(field => field.name === 'What will they do differently?'), false);
  }
});

test('existing patch repair changes only encoded text and preserves saved styling', async () => {
  const data = { title: 'Saved title', description: 'You and [&#8230;]', color: 123, footer: { text: 'Saved footer' } };
  let updated;
  await repairEncodedPatchText({ embeds: [{ toJSON: () => data }], edit: async payload => { updated = payload; } });
  assert.deepEqual(updated, { embeds: [{ ...data, description: 'You and […]' }] });
});
