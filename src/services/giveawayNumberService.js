// Persistent, per-guild giveaway numbering for claim audit logs. Numbers are
// never reused when a giveaway post or its claim channel is deleted.
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { getGuildGiveaways } from '../utils/giveaways.js';

const sequenceKey = guildId => 'guild:' + guildId + ':giveaway-log:numbers-v1';
const validId = value => /^\d{17,20}$/.test(String(value || ''));

export async function getOrCreateGiveawayNumber(client, guildId, messageId) {
  if (!validId(messageId) || !client?.db?.get || !client?.db?.set) {
    throw new Error('Giveaway numbering requires a saved giveaway and persistent database');
  }
  return Mutex.runExclusive('giveaway-log-sequence:' + guildId, async () => {
    const raw = unwrapReplitData(await client.db.get(sequenceKey(guildId), {}, { strict: true }));
    const sequence = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const numbers = sequence.numbers && typeof sequence.numbers === 'object'
      && !Array.isArray(sequence.numbers) ? { ...sequence.numbers } : {};
    let last = Number.isSafeInteger(sequence.last) && sequence.last >= 0 ? sequence.last : 0;
    for (const number of Object.values(numbers)) {
      if (Number.isSafeInteger(number) && number > last) last = number;
    }

    if (Number.isSafeInteger(numbers[messageId]) && numbers[messageId] > 0) {
      return numbers[messageId];
    }

    // When enabling numbering on an established server, seed still-saved
    // giveaways by creation order. This occurs once and does not change posts.
    if (!Object.keys(numbers).length) {
      const existing = await getGuildGiveaways(client, guildId, { strict: true });
      const ordered = existing.filter(item => validId(item?.messageId))
        .sort((a, b) => {
          const left = Date.parse(a.createdAt || '');
          const right = Date.parse(b.createdAt || '');
          if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
          return String(a.messageId).localeCompare(String(b.messageId));
        });
      for (const item of ordered) {
        if (!numbers[item.messageId]) numbers[item.messageId] = ++last;
      }
    }

    if (!numbers[messageId]) numbers[messageId] = ++last;
    if (await client.db.set(sequenceKey(guildId), { last, numbers }) === false) {
      throw new Error('Could not persist giveaway log number');
    }
    return numbers[messageId];
  });
}

// The #N of a giveaway, or null when it never had one. Never creates one.
export async function findGiveawayNumber(client, guildId, messageId) {
  if (!validId(messageId) || !client?.db?.get) return null;
  const raw = unwrapReplitData(await client.db.get(sequenceKey(guildId), {}));
  const number = raw?.numbers?.[messageId];
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// A deleted giveaway's #N links to its deletion log (owner's choice): the
// Embed log entry after /giveaway manage Delete, else the Staff log entry,
// where the deleted giveaway can still be read. Stored per giveaway message,
// so a claim log sent after the deletion links there too.
const deletedLinksKey = guildId => 'guild:' + guildId + ':giveaway-log:deleted-links-v1';
const MESSAGE_URL = /^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}$/;

export const isDiscordMessageUrl = url => MESSAGE_URL.test(String(url || ''));

export async function deletedGiveawayLogUrl(client, guildId, messageId) {
  if (!validId(messageId) || !client?.db?.get) return null;
  const raw = unwrapReplitData(await client.db.get(deletedLinksKey(guildId), {}));
  const url = raw && typeof raw === 'object' ? raw[messageId] : null;
  return isDiscordMessageUrl(url) ? url : null;
}

export async function rememberDeletedGiveawayLogUrl(client, guildId, messageId, url) {
  if (!validId(messageId) || !isDiscordMessageUrl(url) || !client?.db?.get || !client?.db?.set) return false;
  return Mutex.runExclusive('giveaway-deleted-links:' + guildId, async () => {
    const raw = unwrapReplitData(await client.db.get(deletedLinksKey(guildId), {}));
    const links = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    links[messageId] = url;
    return await client.db.set(deletedLinksKey(guildId), links) !== false;
  });
}
