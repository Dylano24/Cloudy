// Controlled Close/Reopen benchmark using the real ticket services against a
// simulated Discord. Every request takes BENCH_RTT_MS and, like discord.js,
// requests to the same route run one at a time. Gateway cache updates arrive
// BENCH_GATEWAY_LAG_MS after a write. Discord's real rate limits are not
// published; by default none are modelled, so timings are a lower bound and
// request counts are exact. BENCH_PUT_LIMIT=n (per BENCH_PUT_WINDOW_MS, default
// 10 s) adds an ASSUMED fixed-window limit on permission edits per channel.
//
//   node scripts/bench-ticket-close-reopen.mjs [runs]
import { performance } from 'node:perf_hooks';
import {
  ChannelType, Collection, OverwriteType, PermissionFlagsBits, PermissionOverwrites, PermissionsBitField,
} from 'discord.js';
import { db, getTicketData, getTicketKey } from '../src/utils/database.js';
import { closeTicket, reopenTicket } from '../src/services/ticketReliabilityService.js';
import { logger } from '../src/utils/logger.js';

for (const level of ['info', 'warn', 'debug', 'error']) logger[level] = () => {};

const RTT = Number(process.env.BENCH_RTT_MS || 150);
const GATEWAY_LAG = Number(process.env.BENCH_GATEWAY_LAG_MS || 100);
const DB_MS = Number(process.env.BENCH_DB_MS || 2);
const RUNS = Number(process.argv[2] || 3);
const PUT_LIMIT = Number(process.env.BENCH_PUT_LIMIT || 0);
const PUT_WINDOW = Number(process.env.BENCH_PUT_WINDOW_MS || 10_000);
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const V = PermissionFlagsBits.ViewChannel;
const FULL = V | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory
  | PermissionFlagsBits.AttachFiles;

async function scenario(run) {
  const id = n => `17${String(run).padStart(4, '0')}${String(n).padStart(12, '0')}`;
  const guildId = id(1), channelId = id(2), creatorId = id(3), staffId = id(4), staffRoleId = id(5);
  const openCategoryId = id(6), closedCategoryId = id(7), logsId = id(8), botId = id(9);
  const values = new Map();
  const storage = {
    get: async key => { await sleep(DB_MS); return structuredClone(values.get(key) ?? null); },
    set: async (key, value) => { await sleep(DB_MS); values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;

  const counts = new Map();
  const queues = new Map();
  const bucket = { resetAt: 0, remaining: PUT_LIMIT };
  let rateLimitedMs = 0;
  const resetBucket = () => { bucket.resetAt = performance.now() + PUT_WINDOW; bucket.remaining = PUT_LIMIT; };
  // Permission edits already run one at a time per route, so this is the
  // only caller touching the bucket while it waits.
  const waitForBucket = async route => {
    if (!PUT_LIMIT || !route.startsWith('PUT ')) return;
    if (performance.now() >= bucket.resetAt) resetBucket();
    if (bucket.remaining <= 0) {
      const wait = bucket.resetAt - performance.now();
      rateLimitedMs += wait;
      await sleep(wait);
      resetBucket();
    }
    bucket.remaining -= 1;
  };
  const rest = (route, operation) => {
    counts.set(route, (counts.get(route) || 0) + 1);
    const run = (queues.get(route) || Promise.resolve()).catch(() => {})
      .then(async () => { await waitForBucket(route); await sleep(RTT); return operation(); });
    queues.set(route, run);
    return run;
  };

  const client = { user: { id: botId }, db: { ...storage, isAvailable: () => true } };
  const staffRole = { id: staffRoleId, name: 'Staff', permissions: new PermissionsBitField() };
  const member = (memberId, staff) => ({ id: memberId, user: { id: memberId, username: memberId },
    permissions: new PermissionsBitField(),
    roles: { cache: new Collection(staff ? [[staffRoleId, staffRole]] : []) },
    toString: () => `<@${memberId}>` });
  const members = new Map([[creatorId, member(creatorId, false)], [staffId, member(staffId, true)]]);
  const guild = { id: guildId, name: 'Cloudy', ownerId: id(10), client,
    roles: { cache: new Collection([[staffRoleId, staffRole]]), fetch: async () => staffRole },
    members: { me: {}, cache: new Collection(members), fetch: async memberId => members.get(memberId) ?? null },
    channels: { cache: new Collection(), fetch: async channelId => guild.channels.cache.get(channelId) ?? null } };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  for (const categoryId of [openCategoryId, closedCategoryId]) {
    guild.channels.cache.set(categoryId, { id: categoryId, type: ChannelType.GuildCategory,
      permissionOverwrites: { cache: new Collection() } });
  }
  guild.channels.cache.set(logsId, { id: logsId, type: ChannelType.GuildText, isSendable: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => rest('POST /channels/logs/messages', () => ({ id: 'log' })) });

  // Discord server state and the lagging Gateway cache of the same channel.
  const server = new Map([
    [guildId, { type: OverwriteType.Role, allow: 0n, deny: V }],
    [creatorId, { type: OverwriteType.Member, allow: FULL, deny: 0n }],
    [staffRoleId, { type: OverwriteType.Role, allow: FULL, deny: 0n }],
  ]);
  const cache = new Collection();
  const copyServerToCache = () => {
    cache.clear();
    for (const [overwriteId, entry] of server) {
      cache.set(overwriteId, { id: overwriteId, type: entry.type,
        allow: new PermissionsBitField(entry.allow), deny: new PermissionsBitField(entry.deny) });
    }
  };
  copyServerToCache();
  const gateway = () => { setTimeout(copyServerToCache, GATEWAY_LAG); };

  const marks = [];
  const message = messageId => {
    const sent = { id: messageId, author: client.user, editable: true, pinned: false, flags: { has: () => false },
      embeds: [{ title: 'Ticket #1' }], components: [],
      edit: async payload => rest('PATCH /channels/:id/messages/:id', () => {
        sent.embeds = payload.embeds || sent.embeds;
        sent.components = payload.components || sent.components;
        return sent;
      }),
      delete: async () => rest('DELETE /channels/:id/messages/:id', () => true) };
    return sent;
  };
  const main = message('main');
  let sends = 0;
  const channel = { id: channelId, name: 'ticket-1', guild, client, parentId: openCategoryId,
    isTextBased: () => true,
    permissionOverwrites: { cache, edit: async (overwriteId, options) => {
      const existing = cache.get(overwriteId);
      const { allow, deny } = PermissionOverwrites.resolveOverwriteOptions(options, existing);
      const type = existing?.type ?? (guild.roles.cache.has(overwriteId) ? OverwriteType.Role : OverwriteType.Member);
      return rest('PUT /channels/:id/permissions/:id', () => {
        server.set(overwriteId, { type, allow: allow.bitfield, deny: deny.bitfield });
        gateway();
        return channel;
      });
    } },
    fetch: async () => rest('GET /channels/:id', () => { copyServerToCache(); return channel; }),
    setParent: async parentId => rest('PATCH /channels/:id', () => { channel.parentId = parentId; gateway(); return channel; }),
    setName: async name => rest('PATCH /channels/:id (name)', () => { channel.name = name; return channel; }),
    messages: { fetch: async messageId => (messageId === 'main' ? main : new Collection()) },
    send: async payload => rest('POST /channels/:id/messages', () => {
      const embed = payload.embeds?.[0];
      const title = (embed?.toJSON?.() ?? embed?.data ?? embed)?.title || '';
      if (title) marks.push({ title, at: performance.now() });
      return message(`status-${++sends}`);
    }) };
  guild.channels.cache.set(channelId, channel);
  values.set(`guild:${guildId}:config`, { ticketStaffRoleId: staffRoleId, ticketCategoryId: openCategoryId,
    ticketClosedCategoryId: closedCategoryId, ticketLogsChannelId: logsId, logging: { enabled: false } });
  values.set(getTicketKey(guildId, channelId), { id: channelId, userId: creatorId, status: 'open',
    ticketNumber: '1', ticketMessageId: 'main', reason: 'Benchmark', pinned: false,
    createdAt: new Date().toISOString() });

  const staff = members.get(staffId);
  const timings = [];
  const started = performance.now();
  const at = ms => sleep(Math.max(0, ms - (performance.now() - started)));
  const close = async () => {
    const t0 = performance.now();
    let visible = null;
    await closeTicket(channel, staff.user, 'Benchmark close', { onVisible: async () => { visible = performance.now(); } });
    timings.push({ action: 'close', visibleMs: visible - t0, completeMs: performance.now() - t0 });
  };
  const reopen = async () => {
    const t0 = performance.now();
    const config = values.get(`guild:${guildId}:config`);
    await reopenTicket(channel, staff, { ticketData: await getTicketData(guildId, channelId), config });
    const shown = marks.findLast(mark => mark.title === 'Ticket reopened');
    timings.push({ action: 'reopen', visibleMs: shown.at - t0, completeMs: performance.now() - t0 });
  };
  // Staff close, reopen, close and reopen within 15 s, as seen in production.
  await close(); await at(3000); await reopen(); await at(9000); await close(); await at(12000); await reopen();
  await at(35000);
  const creator = server.get(creatorId);
  if (!((creator.allow & FULL) === FULL)) throw new Error('creator lost access after the final reopen');
  return { timings, counts: Object.fromEntries([...counts].sort()), rateLimitedMs };
}

const results = [];
for (let run = 1; run <= RUNS; run += 1) results.push(await scenario(run));
const summary = {};
for (const { timings } of results) {
  for (const { action, visibleMs, completeMs } of timings) {
    summary[action] ||= { visible: [], complete: [] };
    summary[action].visible.push(visibleMs);
    summary[action].complete.push(completeMs);
  }
}
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
};
console.log(JSON.stringify({
  model: { rttMs: RTT, gatewayLagMs: GATEWAY_LAG, dbMs: DB_MS, runs: RUNS,
    permissionEditLimit: PUT_LIMIT ? `assumed ${PUT_LIMIT} per ${PUT_WINDOW} ms` : 'not modelled' },
  latency: Object.fromEntries(Object.entries(summary).map(([action, { visible, complete }]) => [action, {
    samples: visible.length, visibleP50Ms: pct(visible, 0.5), visibleP95Ms: pct(visible, 0.95),
    completeP50Ms: pct(complete, 0.5), completeP95Ms: pct(complete, 0.95) }])),
  ...(process.env.BENCH_VERBOSE ? { samples: results.map(result => result.timings) } : {}),
  requestsPerScenario: results[0].counts,
  rateLimitWaitPerScenarioMs: Math.round(results.reduce((sum, result) => sum + result.rateLimitedMs, 0) / RUNS),
}, null, 2));
process.exit(0);
