import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import creatorNotify from '../src/commands/Tools/creatorNotify.js';
import { handleCreatorControls } from '../src/services/creatorDashboardService.js';
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

const SESSION_PREFIX = 'creatornotify:';
function fakeUi(bot) {
  const log = { updates: [], modals: [], followUps: [], deleted: [], root: null };
  const make = (customId, kind, extra = {}) => ({
    customId, guildId: GUILD, user: { id: 'owner' }, client: bot,
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string',
    isChannelSelectMenu: () => kind === 'channel',
    isAnySelectMenu: () => kind === 'string' || kind === 'channel',
    isModalSubmit: () => kind === 'modal',
    isFromMessage: () => true,
    deferUpdate: async () => {},
    update: async payload => { log.updates.push(payload); },
    editReply: async payload => { log.updates.push(payload); },
    showModal: async modal => { log.modals.push(modal); },
    followUp: async payload => { log.followUps.push(payload); return { id: 'notice' }; },
    webhook: { deleteMessage: async id => { log.deleted.push(id); } },
    ...extra,
  });
  return { log, make };
}
async function openDashboard(bot, ui) {
  const root = ui.make('', 'command', {
    guild: bot.guilds.cache.get(GUILD),
    reply: async payload => { ui.log.root = payload; },
    deleteReply: async () => {},
  });
  await creatorNotify.execute(root, {}, bot);
  const sid = ui.log.root.components[0].toJSON().components[0].custom_id.split(':')[2];
  const click = (type, value) => handleCreatorControls(
    ui.make(SESSION_PREFIX + type + ':' + sid + (value ? ':' + value : ''), 'button'), bot);
  const pick = channelId => handleCreatorControls(
    ui.make(SESSION_PREFIX + 'channel:' + sid, 'channel', { values: [channelId] }), bot);
  const submit = link => handleCreatorControls(ui.make(SESSION_PREFIX + 'submit:' + sid, 'modal', {
    fields: { getTextInputValue: () => link },
  }), bot);
  return { sid, click, pick, submit };
}

test('creator-notify is one global command without options that opens a dashboard', () => {
  const data = creatorNotify.data.toJSON();
  assert.equal(data.name, 'creator-notify');
  assert.equal(data.options?.length || 0, 0);
  assert.equal(creatorNotify.globalRegistration, true, 'do not exceed Discord 100 guild commands');
});

test('the dashboard adds, pauses and deletes a creator like /auto feed', async () => {
  const { bot } = fakeBot();
  const ui = fakeUi(bot);
  const flow = await openDashboard(bot, ui);
  const [add, manage] = ui.log.root.components[0].toJSON().components;
  assert.deepEqual([add.label, manage.label, manage.disabled], ['Add creator', 'Manage creator', true]);
  assert.equal(ui.log.root.embeds[0].toJSON().title, 'Creator notifications');

  await flow.click('button', 'add');
  assert.equal(ui.log.updates.at(-1).components.length, 3, 'platform, channel and buttons');
  await flow.pick(CHANNEL);
  assert.equal(ui.log.modals[0].toJSON().title, 'Add creator');
  assert.match(JSON.stringify(ui.log.modals[0].toJSON()), /"placeholder":"https:\/\/www\.youtube\.com\/@"/);
  await flow.submit('https://youtube.com/channel/' + CHANNEL_ID);
  const detail = ui.log.updates.at(-1).embeds[0].toJSON();
  assert.match(detail.fields[0].name, /^YouTube/);
  assert.match(detail.fields[0].value, /\*\*Status:\*\*[^\n]*\n\nExisting posts/);
  const [saved] = await listCreatorNotifications(bot, GUILD);
  assert.deepEqual([saved.id, saved.channelId, saved.enabled], ['youtube:' + CHANNEL_ID, CHANNEL, true]);

  await flow.click('button', 'pause');
  assert.equal((await listCreatorNotifications(bot, GUILD))[0].enabled, false);
  assert.equal(ui.log.updates.at(-1).components[0].toJSON().components[1].label, 'Resume creator');
  await flow.click('button', 'pause');
  const resumed = (await listCreatorNotifications(bot, GUILD))[0];
  assert.deepEqual([resumed.enabled, resumed.initialized], [true, false]);

  await flow.click('button', 'delete');
  assert.deepEqual(await listCreatorNotifications(bot, GUILD), []);
  assert.equal(ui.log.updates.at(-1).components[0].toJSON().components[1].disabled, true);
});

test('a chosen channel is saved and can be changed from the manage screen', async () => {
  const { bot } = fakeBot();
  const ui = fakeUi(bot);
  const flow = await openDashboard(bot, ui);
  await flow.click('button', 'add');
  await flow.pick(CHANNEL);
  assert.equal(ui.log.modals.length, 1);
  await flow.submit('twitch.tv/SomeStreamer');
  assert.equal((await listCreatorNotifications(bot, GUILD))[0].channelId, CHANNEL);
  await flow.click('button', 'channel');
  await flow.pick('1540000000000000000');
  assert.equal((await listCreatorNotifications(bot, GUILD))[0].channelId, '1540000000000000000');
});

test('dashboard errors are red and remove themselves after exactly ten seconds', async t => {
  const { bot } = fakeBot();
  const ui = fakeUi(bot);
  const flow = await openDashboard(bot, ui);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await flow.click('button', 'add');
  await flow.pick(CHANNEL);
  await flow.submit('not a link');
  const embed = ui.log.followUps[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Creator notification error');
  assert.equal(embed.color, CLOUDY_RED_COLOR);
  t.mock.timers.tick(9_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.log.deleted, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.log.deleted, ['notice']);
  t.mock.timers.reset();
});

test('only the opener with Manage Server can use the dashboard', async () => {
  const { bot } = fakeBot();
  const ui = fakeUi(bot);
  const flow = await openDashboard(bot, ui);
  const before = ui.log.updates.length;
  await handleCreatorControls(ui.make(SESSION_PREFIX + 'button:' + flow.sid + ':add', 'button', { user: { id: 'other' } }), bot);
  await handleCreatorControls(ui.make(SESSION_PREFIX + 'button:' + flow.sid + ':add', 'button', { memberPermissions: { has: () => false } }), bot);
  assert.equal(ui.log.updates.length, before);
});

const html = id => '<html><script>{"channelMetadataRenderer":{"externalId":"' + id + '"}}</script></html>';
const page = body => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => body });
const consent = url => ({ status: 303, ok: false, headers: { get: () => 'https://consent.youtube.com/m?continue=' + encodeURIComponent(url) } });

test('a YouTube @handle link resolves to the UC channel and sends the consent cookie', async () => {
  const { bot } = fakeBot();
  const seen = [];
  const fetcher = async (url, options) => { seen.push(options.headers); return page(html(CHANNEL_ID)); };
  const entry = await addCreatorNotification(bot, GUILD, null, 'https://www.youtube.com/@MrBeast', null, { fetcher, env: {} });
  assert.equal(entry.account, CHANNEL_ID);
  assert.match(seen[0].Cookie, /SOCS=/);
});

test('a consent redirect is never reported as an invalid link; the mobile page is tried', async () => {
  const { bot } = fakeBot();
  const urls = [];
  const fetcher = async url => { urls.push(url); return url.includes('//m.youtube.com/') ? page(html(CHANNEL_ID)) : consent(url); };
  const entry = await addCreatorNotification(bot, GUILD, null, 'https://www.youtube.com/@MrBeast', null, { fetcher, env: {} });
  assert.equal(entry.account, CHANNEL_ID);
  assert.equal(urls.length, 2);
  const blocked = async url => consent(url);
  await assert.rejects(
    addCreatorNotification(bot, GUILD, null, 'https://www.youtube.com/@Other', null, { fetcher: blocked, env: {} }),
    error => !/valid link/i.test(error.message) && /YOUTUBE_API_KEY|channel/.test(error.message));
});

test('a video link registers its creator channel, not the video', async () => {
  const { bot } = fakeBot();
  const fetcher = async () => page('<script>"videoDetails":{"videoId":"abcdefghijk","channelId":"' + CHANNEL_ID + '"}</script>');
  const entry = await addCreatorNotification(bot, GUILD, null, 'https://youtu.be/abcdefghijk', null, { fetcher, env: {} });
  assert.equal(entry.id, 'youtube:' + CHANNEL_ID);
});

test('a video link resolves through the YouTube API when a key is configured', async () => {
  const { bot } = fakeBot();
  const fetcher = async url => url.includes('/videos?')
    ? { ok: true, json: async () => ({ items: [{ snippet: { channelId: CHANNEL_ID } }] }) }
    : consent(url);
  const entry = await addCreatorNotification(bot, GUILD, null, 'https://www.youtube.com/watch?v=abcdefghijk', null, { fetcher, env: { YOUTUBE_API_KEY: 'k' } });
  assert.equal(entry.account, CHANNEL_ID);
});

test('an off-site redirect is still refused', async () => {
  const { bot } = fakeBot();
  const fetcher = async () => ({ status: 302, ok: false, headers: { get: () => 'https://evil.example/x' } });
  await assert.rejects(addCreatorNotification(bot, GUILD, null, 'https://www.youtube.com/@MrBeast', null, { fetcher, env: {} }), /unsafe redirect/);
});

test('Twitch and TikTok profile links register without a selected platform', async () => {
  const { bot } = fakeBot();
  const twitch = await addCreatorNotification(bot, GUILD, null, 'https://www.twitch.tv/SomeStreamer', null);
  const tiktok = await addCreatorNotification(bot, GUILD, null, 'https://www.tiktok.com/@some.user?lang=en', null);
  assert.deepEqual([twitch.id, tiktok.id], ['twitch:somestreamer', 'tiktok:some.user']);
});

test('a video link uses oEmbed to find the creator profile, even when the watch page is blocked', async () => {
  const { bot } = fakeBot();
  const fetcher = async url => {
    if (url.includes('/oembed')) return { ok: true, json: async () => ({ author_url: 'https://www.youtube.com/@RickAstleyYT' }) };
    if (url.includes('/@RickAstleyYT')) return page(html(CHANNEL_ID));
    return { status: 302, ok: false, headers: { get: () => 'https://www.google.com/sorry/index?continue=x' } };
  };
  const entry = await addCreatorNotification(bot, GUILD, null, 'https://youtu.be/dQw4w9WgXcQ', null, { fetcher, env: {} });
  assert.equal(entry.id, 'youtube:' + CHANNEL_ID);
});
