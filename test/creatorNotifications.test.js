import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import creatorNotify from '../src/commands/Tools/creatorNotify.js';
import { CLOUDY_RED_COLOR } from '../src/utils/embedColorPolicy.js';
import { withCreatorErrorColor, ensureCreatorErrorColor } from '../src/utils/cloudyFooter.js';
import {
  normalizeCreatorAccount, parseCreatorFeed, fetchCreatorItems, creatorProviderReady,
} from '../src/services/creatorNotificationProviders.js';
import {
  addCreatorNotification, removeCreatorNotification, listCreatorNotifications,
  checkCreatorNotifications,
} from '../src/services/creatorNotificationService.js';

const GUILD = '1520000000000000000';
const CHANNEL = '1530000000000000000';
const CHANNEL_ID = 'UC1234567890123456789012';
function fakeBot() {
  const data = new Map();
  const posts = [];
  const channel = { id: CHANNEL, send: async message => {
    posts.push(message);
    return { id: String(posts.length) };
  } };
  const guild = { id: GUILD, channels: {
    cache: new Map([[CHANNEL, channel]]),
    fetch: async id => id === CHANNEL ? channel : null,
  } };
  const bot = {
    guilds: { cache: new Map([[GUILD, guild]]) },
    db: {
      get: async key => structuredClone(data.get(key) || null),
      set: async (key, value) => { data.set(key, structuredClone(value)); return true; },
    },
  };
  return { bot, posts, data };
}
const item = (id, published) => ({
  id, title: 'Title ' + id, url: 'https://www.youtube.com/watch?v=' + id,
  published, type: 'video',
});

test('accounts are validated without allowing external fetch URLs', () => {
  assert.equal(normalizeCreatorAccount('youtube', CHANNEL_ID), CHANNEL_ID);
  assert.equal(normalizeCreatorAccount('twitch', 'https://www.twitch.tv/Example_Account'), 'example_account');
  assert.equal(normalizeCreatorAccount('tiktok', '@Example.Creator'), 'example.creator');
  assert.throws(() => normalizeCreatorAccount('youtube', 'https://example.com/private'),
    { message: 'YouTube requires a channel ID' });
  assert.throws(() => normalizeCreatorAccount('tiktok', 'http://127.0.0.1/admin'), /Invalid/);
  assert.equal(creatorProviderReady('tiktok', {}), false, 'no misleading TikTok capability without bridge');
  assert.equal(creatorProviderReady('tiktok', { CREATOR_TIKTOK_FEED_TEMPLATE: 'https://bridge.example/rss/{account}' }), true);
});

test('YouTube and TikTok Atom/RSS items are parsed and links restricted to official hosts', () => {
  const yt = '<feed><entry><yt:videoId>ZZ123</yt:videoId><title>New &amp; exciting</title>' +
    '<published>2026-11-11T12:00:00Z</published></entry></feed>';
  const [first] = parseCreatorFeed(yt, 'youtube', CHANNEL_ID);
  assert.equal(first.url, 'https://www.youtube.com/watch?v=ZZ123');
  assert.equal(first.title, 'New & exciting');
  const rss = '<rss><channel><item><guid>t1</guid><title>Dance</title><link>https://www.tiktok.com/@example/video/123</link></item>' +
    '<item><title>Malicious</title><link>https://127.0.0.1/admin</link></item></channel></rss>';
  const entries = parseCreatorFeed(rss, 'tiktok', 'example');
  assert.equal(entries.length, 1);
  assert.match(entries[0].url, /tiktok\.com/);
});

test('new subscription skips existing uploads and announces only new videos once', async () => {
  const { bot, posts } = fakeBot();
  await addCreatorNotification(bot, GUILD, 'youtube', CHANNEL_ID, CHANNEL);
  let current = [item('old', 1)];
  const getItems = async () => current;
  assert.equal(await checkCreatorNotifications(bot, GUILD, { getItems }), 0);
  assert.equal(posts.length, 0, 'existing videos must not be announced when added');
  current = [item('new', 2), item('old', 1)];
  assert.equal(await checkCreatorNotifications(bot, GUILD, { getItems }), 1);
  assert.equal(posts[0].content, 'https://www.youtube.com/watch?v=new');
  assert.equal(posts[0].allowedMentions.parse.length, 0);
  assert.equal(posts[0].embeds[0].footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.equal(await checkCreatorNotifications(bot, GUILD, { getItems }), 0);
  assert.equal(posts.length, 1);
  assert.equal((await listCreatorNotifications(bot, GUILD))[0].initialized, true);
});

test('a failed Discord delivery is retried, not incorrectly marked delivered', async () => {
  const { bot, posts } = fakeBot();
  await addCreatorNotification(bot, GUILD, 'youtube', CHANNEL_ID, CHANNEL);
  let entries = [item('old', 1)];
  const getItems = async () => entries;
  await checkCreatorNotifications(bot, GUILD, { getItems });
  entries = [item('new', 2), item('old', 1)];
  assert.equal(await checkCreatorNotifications(bot, GUILD, {
    getItems, sender: async () => { throw new Error('Discord unavailable'); },
  }), 0);
  assert.equal(await checkCreatorNotifications(bot, GUILD, { getItems }), 1);
  assert.equal(posts.length, 1);
  assert.equal(await removeCreatorNotification(bot, GUILD, 'youtube', CHANNEL_ID), true);
  assert.equal((await listCreatorNotifications(bot, GUILD)).length, 0);
});

test('concurrent checks for the same guild are serialized, without duplicate posts', async () => {
  const { bot, posts } = fakeBot();
  await addCreatorNotification(bot, GUILD, 'youtube', CHANNEL_ID, CHANNEL);
  let postsFromProvider = [item('old', 1)];
  const getItems = async () => postsFromProvider;
  await checkCreatorNotifications(bot, GUILD, { getItems });
  postsFromProvider = [item('new', 2), item('old', 1)];
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    checkCreatorNotifications(bot, GUILD, { getItems })));
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  assert.equal(posts.length, 1);
});

test('Twitch API source collects live streams and VOD links using app credentials', async () => {
  const env = { TWITCH_CLIENT_ID: 'client', TWITCH_CLIENT_SECRET: 'secret' };
  const fetched = [];
  const response = data => ({ ok: true, json: async () => data });
  const fetcher = async url => {
    fetched.push(url);
    if (url.includes('oauth2/token')) return response({ access_token: 'mock', expires_in: 3600 });
    if (url.includes('helix/users')) return response({ data: [{ id: '42' }] });
    if (url.includes('helix/streams')) return response({ data: [{
      id: 'stream-7', title: 'Live now', started_at: '2026-11-11T12:00:00Z',
    }] });
    if (url.includes('helix/videos')) return response({ data: [{
      id: 'vod-8', url: 'https://www.twitch.tv/videos/8', title: 'Recent VOD', published_at: '2026-11-11T10:00:00Z',
    }] });
    throw new Error('Unexpected URL: ' + url);
  };
  const items = await fetchCreatorItems({ platform: 'twitch', account: 'channel' }, { env, fetcher });
  assert.deepEqual(items.map(i => i.id), ['live:stream-7', 'video:vod-8']);
  assert.equal(fetched.length, 4);
});

test('creator-notify exposes only add, remove and list, and invalid YouTube ID uses Cloudy red', async () => {
  const commandNames = creatorNotify.data.toJSON().options.map(option => option.name);
  assert.deepEqual(commandNames, ['add', 'remove', 'list']);
  assert.equal(creatorNotify.globalRegistration, true, 'do not exceed Discord 100 guild commands');

  const interaction = {
    guildId: GUILD,
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => 'add',
      getString: name => name === 'platform' ? 'youtube' : 'not-a-channel-id',
      getChannel: () => null,
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async payload => { interaction.answer = payload; },
  };
  await creatorNotify.execute(interaction, {}, fakeBot().bot);
  const embed = interaction.answer.embeds[0].toJSON();
  assert.equal(embed.title, 'Creator notification error');
  assert.equal(embed.description, 'YouTube requires a channel ID');
  assert.equal(embed.color, CLOUDY_RED_COLOR);
});

test('final Discord REST format keeps creator errors Cloudy red, never yellow', async () => {
  const original = { embeds: [{ title: 'Creator notification error',
    description: 'Use a valid link from the selected platform.',
    color: 0xFCFFA1, footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }] };
  const payload = await withCreatorErrorColor(async () => {
    await Promise.resolve();
    return ensureCreatorErrorColor(original);
  });
  assert.equal(payload.embeds[0].color, CLOUDY_RED_COLOR);
  assert.equal(payload.embeds[0].description, original.embeds[0].description);
  assert.equal(payload.embeds[0].footer.text, original.embeds[0].footer.text);
  assert.equal(ensureCreatorErrorColor(original).embeds[0].color, 0xFCFFA1,
    'scope cannot change unrelated messages');
});

test('all creator-notify success and error notices auto-delete after exactly ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = async (platform, creator) => {
    const client = fakeBot().bot;
    let deleted = 0;
    const interaction = {
      guildId: GUILD,
      memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommand: () => 'add',
        getString: name => name === 'platform' ? platform : creator,
        getChannel: () => null,
      },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async payload => { interaction.answer = payload; },
      deleteReply: async () => { deleted++; },
    };
    await creatorNotify.execute(interaction, {}, client);
    return { interaction, deletions: () => deleted };
  };
  const success = await run('twitch', 'validcreator');
  const error = await run('youtube', 'not-a-channel-id');
  assert.equal(success.interaction.answer.embeds[0].toJSON().title, 'Creator added');
  assert.equal(error.interaction.answer.embeds[0].toJSON().color, CLOUDY_RED_COLOR);
  t.mock.timers.tick(9_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(success.deletions(), 0);
  assert.equal(error.deletions(), 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(success.deletions(), 1);
  assert.equal(error.deletions(), 1);
  t.mock.timers.reset();
});

test('slash add accepts only a pasted YouTube link, without a selected platform', async () => {
  const add = creatorNotify.data.toJSON().options.find(option => option.name === 'add');
  const creator = add.options.find(option => option.name === 'creator');
  const platform = add.options.find(option => option.name === 'platform');
  assert.equal(creator.required, true);
  assert.equal(platform.required, false);
  const client = fakeBot().bot;
  const interaction = {
    guildId: GUILD,
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => 'add',
      getString: name => name === 'creator' ? 'https://youtube.com/channel/' + CHANNEL_ID : null,
      getChannel: () => null,
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async payload => { interaction.answer = payload; },
  };
  await creatorNotify.execute(interaction, {}, client);
  assert.equal(interaction.answer.embeds[0].toJSON().title, 'Creator added');
  assert.match(interaction.answer.embeds[0].toJSON().description, /youtube: UC/);
  const [saved] = await listCreatorNotifications(client, GUILD);
  assert.equal(saved.platform, 'youtube');
  assert.equal(saved.account, CHANNEL_ID);
});
