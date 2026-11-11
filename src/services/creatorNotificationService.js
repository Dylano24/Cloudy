// Persisted per-guild content-creator subscriptions; nothing posts by default.
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_STANDARD_FOOTER } from '../utils/cloudyFooter.js';
import { fetchCreatorItems, normalizeCreatorAccount } from './creatorNotificationProviders.js';

const PREFIX = 'global:creator-notify:';
const CHECK_INTERVAL_MS = 5 * 60_000;
const MAX_CREATORS = 30;
const MAX_ITEMS_PER_POLL = 3;
const MAX_SEEN = 40;
const queues = new Map();
const warned = new Map();
let tickRunning = false;
const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';

function storageKey(guildId) { return PREFIX + guildId; }
async function lockGuild(guildId, task) {
  const key = String(guildId);
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const next = previous.catch(() => {}).then(() => barrier);
  queues.set(key, next);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
  }
}
async function readConfig(client, guildId) {
  const config = await client.db.get(storageKey(guildId));
  return { subscriptions: Array.isArray(config?.subscriptions) ? config.subscriptions : [] };
}
async function storeConfig(client, guildId, config) {
  if (await client.db.set(storageKey(guildId), config) === false) throw new Error('Could not save creator notification configuration.');
}
export async function listCreatorNotifications(client, guildId) {
  return structuredClone((await readConfig(client, guildId)).subscriptions);
}
export async function addCreatorNotification(client, guildId, platform, rawAccount, channelId) {
  const account = normalizeCreatorAccount(platform, rawAccount);
  return lockGuild(guildId, async () => {
    const config = await readConfig(client, guildId);
    const id = platform + ':' + account;
    if (config.subscriptions.some(item => item.id === id)) throw new Error('This creator is already being monitored.');
    if (config.subscriptions.length >= MAX_CREATORS) throw new Error('Maximum 30 creators per server.');
    const entry = { id, platform, account, channelId: channelId || null, initialized: false, enabled: true, seen: [] };
    config.subscriptions.push(entry);
    await storeConfig(client, guildId, config);
    return structuredClone(entry);
  });
}
export async function removeCreatorNotification(client, guildId, platform, rawAccount) {
  const account = normalizeCreatorAccount(platform, rawAccount);
  return lockGuild(guildId, async () => {
    const config = await readConfig(client, guildId);
    const oldLength = config.subscriptions.length;
    config.subscriptions = config.subscriptions.filter(item => item.id !== platform + ':' + account);
    if (oldLength === config.subscriptions.length) return false;
    await storeConfig(client, guildId, config);
    return true;
  });
}

export function buildCreatorNotification(item, subscription) {
  const platform = subscription.platform[0].toUpperCase() + subscription.platform.slice(1);
  const title = item.type === 'live' ? platform + ' is live!' : 'New ' + platform + ' video';
  return {
    content: item.url,
    embeds: [{
      title,
      description: '**' + subscription.account + '**\n' + String(item.title).replace(/@/g, '@\u200b').slice(0, 240),
      color: 0xFFFFFF,
      thumbnail: { url: LOGO },
      footer: { text: CLOUDY_STANDARD_FOOTER },
    }],
    allowedMentions: { parse: [] },
  };
}
function warnOnce(id, error) {
  if ((warned.get(id) || 0) + 60 * 60_000 > Date.now()) return;
  warned.set(id, Date.now());
  logger.warn('[CREATOR_NOTIFY] ' + id + ': ' + error.message);
}

async function pollGuild(client, guild, options = {}) {
  return lockGuild(guild.id, async () => {
    const config = await readConfig(client, guild.id);
    let posted = 0;
    for (const sub of config.subscriptions) {
      if (!sub.enabled) continue;
      let items;
      try {
        items = await (options.getItems || fetchCreatorItems)(sub, options);
      } catch (error) {
        warnOnce(sub.id, error);
        continue;
      }
      if (!sub.initialized) {
        // First successful fetch seeds the last IDs, without reposting old videos.
        sub.seen = [...new Set(items.map(item => item.id))].slice(0, MAX_SEEN);
        sub.initialized = true;
        await storeConfig(client, guild.id, config);
        continue;
      }
      const seen = new Set(sub.seen || []);
      const unseen = items.filter(item => !seen.has(item.id))
        .sort((a, b) => a.published - b.published).slice(-MAX_ITEMS_PER_POLL);
      if (!unseen.length) continue;
      const channel = sub.channelId
        ? guild.channels.cache.get(sub.channelId) || await guild.channels.fetch(sub.channelId).catch(() => null)
        : await resolveCloudyChannel(client, sub.platform, { guild, textOnly: true });
      if (!channel?.send) continue;
      for (const item of unseen) {
        try {
          await (options.sender ? options.sender(channel, buildCreatorNotification(item, sub))
            : channel.send(buildCreatorNotification(item, sub)));
          sub.seen = [...new Set([item.id, ...(sub.seen || [])])].slice(0, MAX_SEEN);
          await storeConfig(client, guild.id, config);
          posted++;
        } catch (error) {
          warnOnce(sub.id + ':post', error);
          break; // Do not mark failed posts as delivered.
        }
      }
    }
    return posted;
  });
}
export async function checkCreatorNotifications(client, guildId, options = {}) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new Error('The server is unavailable.');
  return pollGuild(client, guild, options);
}
export async function runCreatorNotificationTick(client, options = {}) {
  if (tickRunning) return 0;
  tickRunning = true;
  let posted = 0;
  try {
    for (const guild of client.guilds.cache.values()) {
      if ((await readConfig(client, guild.id)).subscriptions.length) {
        posted += await pollGuild(client, guild, options);
      }
    }
    return posted;
  } finally { tickRunning = false; }
}
export function startCreatorNotificationMonitor(client) {
  const first = setTimeout(() => {
    void runCreatorNotificationTick(client).catch(error => logger.warn('[CREATOR_NOTIFY] Initial check: ' + error.message));
  }, 15_000);
  first.unref?.();
  const timer = setInterval(() => {
    void runCreatorNotificationTick(client).catch(error => logger.warn('[CREATOR_NOTIFY] Check: ' + error.message));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
