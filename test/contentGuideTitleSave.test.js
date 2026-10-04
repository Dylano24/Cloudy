import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, EmbedBuilder } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { createContentCreatorGuideManager } from '../src/services/contentCreatorGuideService.js';

test('Builder title Save stays on the live guide after a post and restart, without exposing catalog metadata', async () => {
  const values = new Map();
  const storage = { get: async key => structuredClone(values.get(key) || null), set: async (key, value) => { values.set(key, structuredClone(value)); return true; }, list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage };
  const history = new Collection();
  const guild = { id: 'guide-title-save', client, channels: { cache: new Collection() } };
  const channel = { id: 'tiktok', name: 'tiktok', guild, client };
  guild.channels.cache.set(channel.id, channel);
  let next = 100;
  const add = (author, embeds, content = '') => {
    const msg = { id: String(++next), guildId: guild.id, channelId: channel.id, guild, channel, client, author, content, embeds: embeds.map(e => new EmbedBuilder(e)), editable: true, components: [], attachments: new Collection(),
      async edit(payload) { this.embeds = payload.embeds.map(e => new EmbedBuilder(e)); return this; }, async delete() { history.delete(this.id); } };
    history.set(msg.id, msg); channel.lastMessageId = msg.id; return msg;
  };
  channel.messages = { fetch: async options => typeof options === 'string' ? history.get(options) : options.message ? history.get(options.message) : new Collection([...history].reverse()) };
  channel.send = async payload => add(client.user, payload.embeds);
  const original = { title: '🎥 Content Creators', description: 'Original subscription guide', color: 0xFFFFFF, footer: { text: 'Cloudy footer' }, author: { name: 'Cloudy template key: embed-type:f650e21a || Cloudy context: botlog/content-creator-guide-service || Cloudy kind: embed' } };
  const message = add(client.user, [original]);
  values.set(`global:content-creators:guide:${guild.id}:${channel.id}`, { messageId: message.id });
  const state = { title: '🎥 My saved title', message: original.description, sideColor: original.color, bottomLine: original.footer.text, embedFields: [], modifyTarget: { channelId: channel.id, messageId: message.id, embedIndex: 0, sourceEmbedData: original, cachedMessage: message, templateMode: true, templateTitle: 'embed-type:f650e21a' } };
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].toJSON().title, state.title);
  assert.equal(message.embeds[0].toJSON().author, undefined);
  for (let pass = 0; pass < 2; pass++) {
    add({ id: 'member' }, []);
    await createContentCreatorGuideManager().refresh(channel);
    const guides = [...history.values()].filter(m => m.author.id === 'bot');
    assert.equal(guides.length, 1);
    assert.equal(guides[0].embeds[0].toJSON().title, state.title);
    assert.equal(guides[0].embeds[0].toJSON().author, undefined);
    assert.equal(guides[0].embeds[0].toJSON().description, original.description);
  }
});

