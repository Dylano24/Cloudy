import { AuditLogEvent } from 'discord.js';

export const AUTOMOD_LOG_CHANNEL_ID = '1556209466679238696';

// What happened to the message, shown as "Type" in Staff/Member logs.
export const DELETION_TYPES = Object.freeze({
  self: 'Deleted by author',
  staff: 'Deleted by staff',
  bot: 'Deleted by bot',
  cloudy: 'Deleted by Cloudy',
  automod: 'Removed by AutoMod',
  ban: 'Removed by ban',
  bulk: 'Bulk delete',
  unknown: 'Deleted (deleter could not be verified)',
});

const UNKNOWN = Object.freeze({ label: 'Unknown', source: 'unknown', type: DELETION_TYPES.unknown });

// Discord audit-log facts this service is built on:
// - an entry never names the deleted message;
// - deleting your own message (member or bot) creates no entry at all;
// - repeated deletions by one executor of one author in one channel are
//   merged into ONE entry whose extra.count increases (its timestamp stays).
// So each deletion by another person must consume exactly one NEW count
// increment of the matching executor/author/channel entry.
const AUDIT_PAGE_SIZE = 100;
const AUDIT_FETCH_SHARE_MS = 300;
// Checks run this long after the gateway event. The last check decides
// whether "nobody else deleted it" can be stated.
const DEFAULT_ATTEMPT_DELAYS_MS = [200, 450, 800];
// Deletions of the same author in the same channel this close together are
// one burst: their evidence is weighed together, never first-come.
const BURST_WINDOW_MS = 3_000;
// An increment is evidence only for a deletion detected around that time.
const EVIDENCE_WINDOW_MS = 5_000;
const BAN_LOOKBACK_MS = 60_000;
const ENTRY_RETENTION_MS = 6 * 60 * 60_000;
const MAX_TRACKED_ENTRIES = 500;

const intents = new Map();
const trackers = new Map();
// Message IDs Cloudy itself asked Discord to delete. Recorded when the REST
// request starts, so the gateway event can never arrive before the mark.
const cloudyDeletions = new Map();
const CLOUDY_DELETION_TTL_MS = 120_000;
const CHANNEL_MESSAGE_ROUTE = /^\/channels\/\d+\/messages\/(\d+)$/;
const BULK_DELETE_ROUTE = /^\/channels\/\d+\/messages\/bulk-delete$/;
const RECORDER_INSTALLED = Symbol('cloudyDeletionRecorder');

export function rememberMessageDeleter(message, user, source = 'staff') {
  const key = `${message.guild?.id}:${message.id}`;
  const automod = source === 'automod';
  const intent = {
    id: user?.id,
    label: automod ? (user?.id ? `<@${user.id}> (AutoMod)` : 'AutoMod') : user?.id ? `<@${user.id}>` : 'Unknown',
    source,
    type: automod ? DELETION_TYPES.automod : DELETION_TYPES.staff,
  };
  intents.set(key, intent);
  const timer = setTimeout(() => { if (intents.get(key) === intent) intents.delete(key); }, 120_000);
  timer.unref?.();
}

function markCloudyDeletions(ids, state) {
  for (const id of ids) {
    const key = String(id);
    const mark = { state, at: Date.now() };
    cloudyDeletions.set(key, mark);
    const timer = setTimeout(() => { if (cloudyDeletions.get(key) === mark) cloudyDeletions.delete(key); }, CLOUDY_DELETION_TTL_MS);
    timer.unref?.();
  }
}

function forgetCloudyDeletions(ids) {
  for (const id of ids) cloudyDeletions.delete(String(id));
}

/**
 * Records every message deletion Cloudy sends through its REST client
 * (message.delete, channel.bulkDelete). Such deletions are then attributed
 * to Cloudy directly instead of being inferred from the audit log.
 */
export function installCloudyDeletionRecorder(rest) {
  if (!rest || rest[RECORDER_INSTALLED]) return Boolean(rest);
  const wrap = (method, idsFor) => {
    const original = rest[method];
    if (typeof original !== 'function') return;
    rest[method] = async function recordedRequest(fullRoute, options) {
      const ids = idsFor(String(fullRoute || ''), options);
      if (!ids.length) return original.call(this, fullRoute, options);
      markCloudyDeletions(ids, 'pending');
      try {
        const result = await original.call(this, fullRoute, options);
        markCloudyDeletions(ids, 'done');
        return result;
      } catch (error) {
        // 404/403: Cloudy did not delete it (someone else may have).
        forgetCloudyDeletions(ids);
        throw error;
      }
    };
  };
  wrap('delete', route => {
    const id = CHANNEL_MESSAGE_ROUTE.exec(route)?.[1];
    return id ? [id] : [];
  });
  wrap('post', (route, options) => (BULK_DELETE_ROUTE.test(route) && Array.isArray(options?.body?.messages)
    ? options.body.messages.map(String) : []));
  rest[RECORDER_INSTALLED] = true;
  return true;
}

function cloudyResult(client, type = DELETION_TYPES.cloudy) {
  const id = client?.user?.id;
  return id ? { id: String(id), label: `<@${id}>`, source: 'cloudy', type } : { ...UNKNOWN };
}

function trackerFor(guildId) {
  const key = String(guildId);
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = {
      primedAt: 0,
      entries: new Map(),
      fetches: new Map(),
      pending: new Set(),
      expected: [],
      ambiguous: [],
    };
    trackers.set(key, tracker);
  }
  return tracker;
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => { setTimeout(resolve, ms); }) : Promise.resolve();
}

// Near-simultaneous deletions share one audit-log request per guild/type,
// but only a request that started after the caller's deletion was seen:
// an older page cannot contain that deletion's audit entry.
function fetchAuditEntries(guild, type, limit = AUDIT_PAGE_SIZE, notBefore = 0) {
  const tracker = trackerFor(guild.id);
  const key = `${type}:${limit}`;
  const shared = tracker.fetches.get(key);
  if (shared && shared.startedAt >= notBefore && Date.now() - shared.startedAt < AUDIT_FETCH_SHARE_MS) return shared.promise;
  const promise = Promise.resolve()
    .then(() => guild.fetchAuditLogs({ type, limit }))
    .then(logs => [...(logs?.entries?.values?.() || [])]);
  tracker.fetches.set(key, { startedAt: Date.now(), promise });
  promise.catch(() => {
    if (tracker.fetches.get(key)?.promise === promise) tracker.fetches.delete(key);
  });
  return promise;
}

const sameId = (left, right) => String(left || '') === String(right || '');

// Synchronous: merge one fetched page. An entry first seen after the
// baseline is new evidence (dated by Discord); a higher count on a known
// entry adds increments dated when Cloudy observed them.
function absorbDeleteEntries(tracker, entries, now = Date.now()) {
  for (const entry of entries) {
    if (!entry?.id || !entry.executor?.id) continue;
    const count = Math.max(1, Number(entry.extra?.count) || 1);
    const record = tracker.entries.get(entry.id);
    if (!record) {
      const createdAt = Number(entry.createdTimestamp) || now;
      // After the baseline, every unseen entry is new. Without one, only an
      // entry Discord created moments ago (one deletion) can be new evidence.
      const fresh = tracker.primedAt > 0
        ? createdAt >= tracker.primedAt - 1_000
        : count === 1 && now - createdAt <= EVIDENCE_WINDOW_MS;
      tracker.entries.set(entry.id, {
        entry,
        count,
        seenAt: now,
        increments: fresh ? Array.from({ length: count }, () => ({ at: createdAt, fresh: true })) : [],
      });
      continue;
    }
    record.entry = entry;
    record.seenAt = now;
    for (let index = record.count; index < count; index += 1) record.increments.push({ at: now, fresh: false });
    record.count = Math.max(record.count, count);
  }
  for (const [id, record] of tracker.entries) {
    record.increments = record.increments.filter(increment => now - increment.at <= EVIDENCE_WINDOW_MS * 4);
    if (now - record.seenAt > ENTRY_RETENTION_MS) tracker.entries.delete(id);
  }
  // Keep the entries Discord still shows; drop those seen longest ago.
  if (tracker.entries.size > MAX_TRACKED_ENTRIES) {
    const oldest = [...tracker.entries].sort((left, right) => left[1].seenAt - right[1].seenAt);
    for (const [id] of oldest.slice(0, tracker.entries.size - MAX_TRACKED_ENTRIES)) tracker.entries.delete(id);
  }
  tracker.expected = tracker.expected.filter(item => now - item.detectedAt <= EVIDENCE_WINDOW_MS * 4);
  tracker.ambiguous = tracker.ambiguous.filter(flag => now - flag.to <= 60_000);
  reconcileExpected(tracker);
}

// A deletion Cloudy already attributed (AutoMod, report action) still made
// an audit increment with Cloudy as executor. Consume it so it is never
// mistaken for evidence about a different deletion of the same author.
function reconcileExpected(tracker) {
  tracker.expected = tracker.expected.filter(item => {
    for (const record of tracker.entries.values()) {
      const { entry } = record;
      if (!sameId(entry.executor?.id, item.executorId) || !sameId(entry.target?.id, item.authorId)
        || !sameId(entry.extra?.channel?.id, item.channelId)) continue;
      const index = record.increments.findIndex(increment => Math.abs(increment.at - item.detectedAt) <= EVIDENCE_WINDOW_MS);
      if (index >= 0) {
        record.increments.splice(index, 1);
        return false;
      }
    }
    return true;
  });
}

export async function primeDeletionAuditBaseline(guild) {
  if (!guild?.id || typeof guild.fetchAuditLogs !== 'function') return false;
  try {
    const tracker = trackerFor(guild.id);
    const entries = await fetchAuditEntries(guild, AuditLogEvent.MessageDelete);
    absorbDeleteEntries(tracker, entries);
    if (!tracker.primedAt) tracker.primedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function executorResult(executor, client, { source = 'audit', type = null } = {}) {
  const cloudy = Boolean(executor?.id) && sameId(executor.id, client?.user?.id);
  return {
    id: String(executor.id),
    label: `<@${executor.id}>`,
    source,
    type: type || (cloudy ? DELETION_TYPES.cloudy : executor.bot ? DELETION_TYPES.bot : DELETION_TYPES.staff),
  };
}

function inBurst(left, right) {
  return sameId(left.channelId, right.channelId) && Math.abs(left.detectedAt - right.detectedAt) <= BURST_WINDOW_MS;
}

// Deletions whose evidence could be confused with this one: same channel
// and same author, plus deletions whose author is unknown in that channel.
function burstFor(tracker, item) {
  return [...tracker.pending].filter(other => inBurst(item, other)
    && (!item.authorId || !other.authorId || sameId(other.authorId, item.authorId)));
}

function flagAmbiguous(tracker, group) {
  const times = group.map(item => item.detectedAt);
  for (const item of group) {
    tracker.ambiguous.push({ channelId: item.channelId, authorId: item.authorId, from: Math.min(...times), to: Math.max(...times) });
  }
}

function isFlaggedAmbiguous(tracker, item) {
  return tracker.ambiguous.some(flag => sameId(flag.channelId, item.channelId)
    && (!flag.authorId || !item.authorId || sameId(flag.authorId, item.authorId))
    && item.detectedAt >= flag.from - BURST_WINDOW_MS && item.detectedAt <= flag.to + BURST_WINDOW_MS);
}

function evidenceFor(tracker, item) {
  const evidence = [];
  for (const record of tracker.entries.values()) {
    const { entry } = record;
    if (!sameId(entry.extra?.channel?.id, item.channelId)) continue;
    if (item.authorId && !sameId(entry.target?.id, item.authorId)) continue;
    for (const increment of record.increments) {
      if (Math.abs(increment.at - item.detectedAt) <= EVIDENCE_WINDOW_MS) evidence.push({ record, increment });
    }
  }
  return evidence;
}

// Synchronous decision: reading evidence and consuming one increment can
// never interleave with another deletion's decision.
function decide(tracker, item, { final }) {
  if (isFlaggedAmbiguous(tracker, item)) return { status: 'ambiguous' };
  const group = burstFor(tracker, item);
  const evidence = evidenceFor(tracker, item);
  const executors = new Set(evidence.map(({ record }) => String(record.entry.executor.id)));
  const targets = new Set(evidence.map(({ record }) => String(record.entry.target?.id || '')));
  if (executors.size > 1 || (!item.authorId && targets.size > 1)) {
    flagAmbiguous(tracker, group);
    return { status: 'ambiguous' };
  }

  const enough = item.authorId
    ? evidence.length > 0 && evidence.length >= group.length
    // Unknown author: only a lone deletion with exactly one candidate.
    : group.length === 1 && evidence.length === 1;
  // Before the last check, only accept evidence that Discord dated before
  // this deletion was seen (or a count increment), so a deletion that
  // happens a moment later cannot be claimed by this one.
  const settled = final || evidence.every(({ increment }) => !increment.fresh || increment.at <= item.detectedAt + 250);
  if (enough && settled) {
    const chosen = evidence.sort((left, right) => left.increment.at - right.increment.at)[0];
    chosen.record.increments.splice(chosen.record.increments.indexOf(chosen.increment), 1);
    return { status: 'matched', entry: chosen.record.entry };
  }
  if (!final) return { status: 'wait' };
  if (!evidence.length) return { status: 'none' };
  // Some, but not all, deletions in this burst were done by someone else.
  // Audit logs cannot tell which ones: name nobody.
  flagAmbiguous(tracker, group);
  return { status: 'ambiguous' };
}

async function findBan(guild, authorId, detectedAt) {
  // A ban's message clean-up happens after the ban entry is written.
  const entries = await fetchAuditEntries(guild, AuditLogEvent.MemberBanAdd, 10, detectedAt);
  return entries.find(entry => entry.executor?.id && sameId(entry.target?.id, authorId)
    && Number(entry.createdTimestamp) >= detectedAt - BAN_LOOKBACK_MS
    && Number(entry.createdTimestamp) <= detectedAt + EVIDENCE_WINDOW_MS) || null;
}

/**
 * Identifies who deleted one message without guessing:
 * - deletions Cloudy performed itself (AutoMod, purge, report actions) are
 *   known from their intent;
 * - another person's deletion is a new audit increment for this channel and
 *   author, weighed together with every simultaneous deletion of that author;
 * - the author deleted it themself only when the audit log was readable,
 *   had a baseline from before the deletion, still showed no increment at
 *   the last check, and the author was not just banned.
 * Everything that cannot be verified stays "Unknown".
 */
export async function resolveMessageDeleter(message, {
  bulk = false,
  authorId = null,
  authorBot = null,
  detectedAt = Date.now(),
  attemptDelaysMs = DEFAULT_ATTEMPT_DELAYS_MS,
} = {}) {
  const guild = message?.guild;
  if (!guild?.id) return { ...UNKNOWN };
  const author = authorId || message.author?.id || null;
  const channelId = message.channelId || message.channel?.id || null;
  const tracker = trackerFor(guild.id);
  const cloudyId = message.client?.user?.id;
  // Cloudy deleted it: its audit increment (if the author is someone else)
  // belongs to this deletion and must not count as evidence for another.
  const expectCloudyIncrement = () => {
    if (bulk || !author || !cloudyId || sameId(author, cloudyId)) return;
    tracker.expected.push({ channelId, authorId: String(author), executorId: String(cloudyId), detectedAt });
    reconcileExpected(tracker);
  };
  const known = intents.get(`${guild.id}:${message.id}`);
  if (known) {
    expectCloudyIncrement();
    return bulk ? { ...known, type: DELETION_TYPES.bulk } : { ...known };
  }
  const cloudyMark = () => cloudyDeletions.get(String(message.id))?.state || null;
  if (cloudyMark() === 'done') {
    expectCloudyIncrement();
    return cloudyResult(message.client, bulk ? DELETION_TYPES.bulk : DELETION_TYPES.cloudy);
  }
  if (typeof guild.fetchAuditLogs !== 'function' || !channelId) return { ...UNKNOWN };
  if (bulk) return (await resolveBulkDeletion(message, [message], { detectedAt }))(message);

  const item = { channelId: String(channelId), authorId: author ? String(author) : null, detectedAt };
  const baselineBeforeDeletion = tracker.primedAt > 0 && tracker.primedAt <= detectedAt;
  tracker.pending.add(item);
  const bot = authorBot ?? message.author?.bot ?? false;
  const cloudyAuthor = sameId(item.authorId, cloudyId);
  let banLookup = null;
  try {
    let nobodyElse = false;
    for (const [index, delay] of attemptDelaysMs.entries()) {
      await sleep(detectedAt + delay - Date.now());
      if (cloudyMark() === 'done') {
        expectCloudyIncrement();
        return cloudyResult(message.client);
      }
      const final = index === attemptDelaysMs.length - 1;
      let entries;
      try {
        // Only a possible self-deletion needs the ban check; run it beside
        // the last audit read. Bots are not banned for their messages.
        if (final && item.authorId && !bot && !banLookup) {
          banLookup = findBan(guild, item.authorId, detectedAt).catch(() => undefined);
        }
        // A read that started up to 150 ms before this check (and after the
        // deletion was seen) is shared by simultaneous deletions.
        entries = await fetchAuditEntries(guild, AuditLogEvent.MessageDelete, AUDIT_PAGE_SIZE, detectedAt + Math.max(0, delay - 150));
      } catch {
        continue;
      }
      absorbDeleteEntries(tracker, entries);
      if (!tracker.primedAt) tracker.primedAt = Date.now();
      const decision = decide(tracker, item, { final });
      if (decision.status === 'ambiguous') return { ...UNKNOWN };
      if (decision.status === 'matched') {
        const result = executorResult(decision.entry.executor, message.client);
        if (!item.authorId && decision.entry.target?.id) result.authorId = String(decision.entry.target.id);
        return result;
      }
      if (decision.status === 'none') nobodyElse = true;
    }

    // Only the LAST check may state that nobody else deleted it, and only
    // against a baseline that existed before the deletion.
    if (!nobodyElse || !baselineBeforeDeletion || !item.authorId) return { ...UNKNOWN };
    // Cloudy's own delete request is still in flight: wait for its result
    // rather than calling it a self-deletion.
    if (cloudyMark() === 'pending') return { ...UNKNOWN };
    const ban = banLookup ? await banLookup : null;
    if (ban === undefined) return { ...UNKNOWN };
    if (ban) return executorResult(ban.executor, message.client, { source: 'ban', type: DELETION_TYPES.ban });
    return {
      id: item.authorId,
      label: `<@${item.authorId}>`,
      source: 'self',
      type: cloudyAuthor ? DELETION_TYPES.cloudy : bot ? DELETION_TYPES.bot : DELETION_TYPES.self,
    };
  } finally {
    tracker.pending.delete(item);
  }
}

/**
 * Resolves one bulk deletion (purge, ban message clean-up) once for all its
 * messages and returns a per-message lookup. Discord's bulk entry names the
 * channel and executor, not the messages.
 */
export async function resolveBulkDeletion(sample, messages = [], {
  detectedAt = Date.now(),
  attemptDelaysMs = [200, 600],
  authorIdFor = message => message?.author?.id || null,
} = {}) {
  const guild = sample?.guild;
  const channelId = sample?.channelId || sample?.channel?.id;
  let shared = { ...UNKNOWN, type: DELETION_TYPES.bulk };
  const bans = new Map();
  if (guild?.id && channelId && typeof guild.fetchAuditLogs === 'function') {
    const cloudyBulk = messages.length > 0
      && messages.every(message => cloudyDeletions.get(String(message?.id))?.state === 'done'
        || intents.has(`${guild.id}:${message?.id}`));
    for (const delay of cloudyBulk ? [] : attemptDelaysMs) {
      await sleep(detectedAt + delay - Date.now());
      let entries;
      try {
        entries = await fetchAuditEntries(guild, AuditLogEvent.MessageBulkDelete, 10, detectedAt + Math.max(0, delay - 150));
      } catch {
        continue;
      }
      const matches = entries.filter(entry => entry.executor?.id
        && sameId(entry.target?.id || entry.extra?.channel?.id, channelId)
        && Math.abs((Number(entry.createdTimestamp) || 0) - detectedAt) <= EVIDENCE_WINDOW_MS * 2);
      const executors = new Set(matches.map(entry => String(entry.executor.id)));
      if (executors.size > 1) break;
      if (executors.size === 1) {
        shared = executorResult(matches[0].executor, sample.client, { type: DELETION_TYPES.bulk });
        break;
      }
    }
    if (shared.source === 'unknown' && !cloudyBulk) {
      const authors = [...new Set(messages.map(authorIdFor).filter(Boolean).map(String))];
      await Promise.all(authors.slice(0, 10).map(async authorId => {
        const ban = await findBan(guild, authorId, detectedAt).catch(() => null);
        if (ban) bans.set(authorId, executorResult(ban.executor, sample.client, { source: 'ban', type: DELETION_TYPES.ban }));
      }));
    }
  }
  return message => {
    const known = guild?.id ? intents.get(`${guild.id}:${message?.id}`) : null;
    if (known) return { ...known, type: DELETION_TYPES.bulk };
    if (cloudyDeletions.get(String(message?.id))?.state === 'done') return cloudyResult(sample.client, DELETION_TYPES.bulk);
    const authorId = authorIdFor(message);
    return { ...(bans.get(String(authorId || '')) || shared) };
  };
}

export function isBotActionFeedback(message) {
  if (!message.author?.bot || message.author.id !== message.client.user?.id) return false;
  if (message.flags?.has?.(64) || (Number(message.flags?.bitfield || message.flags || 0) & 64)) return true;
  return (message.embeds || []).some(embed => /^(?:success|error|warning|permission denied|report submitted|message submitted|messages purged|ticket (?:created|deleted|closed|reopened|claimed|unclaimed)|spam detected|image removed)$/i.test(String(embed.title || embed.data?.title || '').trim()));
}

// Test helper: forget all per-guild audit tracking, intents and marks.
export function resetDeletionAttributionState() {
  trackers.clear();
  intents.clear();
  cloudyDeletions.clear();
}
