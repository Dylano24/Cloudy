import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReportNumber, loadReport } from '../src/services/reportCaseService.js';

test('fallback counter resumes after highest persisted case number and never reuses an older number', async () => {
  const db = new Map([
    ['global:report-counter:123', 7],
    ['global:report:123:message-1', { number: 106 }],
    ['global:report:123:message-2', { number: 99 }],
    ['global:report:other:message-3', { number: 400 }],
  ]);
  const client = { db: {
    isDegraded: () => false, isAvailable: () => true,
    get: async key => db.get(key),
    set: async (key, value) => { db.set(key, value); return true; },
    list: async prefix => [...db.keys()].filter(key => key.startsWith(prefix)),
  } };
  assert.equal(await nextReportNumber(client, '123'), 107);
  assert.equal(await nextReportNumber(client, '123'), 108);
  assert.equal(db.get('global:report-counter:123'), 108);
});

test('simultaneous fallback report reservations are serialized and unique', async () => {
  const values = new Map([['global:report-counter:123', 10]]);
  const client = { db: {
    isDegraded: () => false, isAvailable: () => true,
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); return true; },
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  } };
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => nextReportNumber(client, '123'))), [11,12,13,14,15]);
});

test('PostgreSQL report counter reconciles case numbers with one atomic statement', async () => {
  const calls = [];
  const client = { db: {
    isDegraded: () => false, isAvailable: () => true,
    db: { pool: { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ value: 107 }] };
    } } },
  } };
  assert.equal(await nextReportNumber(client, '123'), 107);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['global:report-counter:123', 'global:report:123:%', 0]);
  assert.match(calls[0].sql, /MAX\(CASE/);
  assert.match(calls[0].sql, /value ->> 'number'/);
  assert.match(calls[0].sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(calls[0].sql, /GREATEST\(/);
  assert.match(calls[0].sql, /RETURNING value/);
  assert.match(calls[0].sql, /expires_at = NULL/);
});

test('legacy reports retain the number in their original message when first handled', async () => {
  const values = new Map();
  const client = { db: {
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); return true; },
  } };
  const report = { id: 'old-id', channelId: 'reports', embeds: [{
    title: 'New report #106',
    fields: [{ name: 'Reported by', value: '<@123456789012345678>' }],
  }] };
  const recorded = await loadReport(client, { id: '123' }, report, 'target');
  assert.equal(recorded.number, 106);
  assert.equal(values.get('global:report:123:old-id').number, 106);
});

test('new report starts at 113 after archived Discord staff reports reached #112', async () => {
  let fetches = 0;
  const messages = [
    { id: 'a', author: { id: 'bot' }, embeds: [{ title: 'New report #112' }] },
    { id: 'b', author: { id: 'bot' }, embeds: [{ title: 'New report #103' }] },
    { id: 'c', author: { id: 'intruder' }, embeds: [{ title: 'New report #9000' }] },
  ];
  const batch = { size: messages.length, values: () => messages.values(), last: () => messages[messages.length - 1] };
  const archive = { messages: { fetch: async () => { fetches++; return batch; } } };
  const channel = { cache: new Map([['1554538663512248350', archive]]), fetch: async id =>
    id === '1554538663512248350' ? archive : null };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['123', { channels: channel }]]) } };
  let counter = 103;
  const paramsSeen = [];
  client.db = {
    isDegraded: () => false, isAvailable: () => true,
    db: { pool: { query: async (sql, params) => {
      paramsSeen.push(params);
      counter = Math.max(counter, params[2]) + 1;
      return { rows: [{ value: counter }] };
    } } },
  };
  assert.equal(await nextReportNumber(client, '123'), 113);
  assert.equal(await nextReportNumber(client, '123'), 114);
  assert.equal(fetches, 1, 'staff history is read once per bot process, not for every report');
  assert.deepEqual(paramsSeen.map(params => params[2]), [112, 113]);
});

test('staff report-log history supplies a higher number when the original staff report is gone', async () => {
  const log = { messages: { fetch: async () => ({
    size: 1,
    values: () => [{ author: { id: 'bot' }, embeds: [{
      title: 'Report update', fields: [{ name: 'Report', value: '#118' }],
    }] }].values(),
    last: () => ({ id: 'historical-log' }),
  }) } };
  const channels = { cache: new Map([['1556344268099166319', log]]), fetch: async id =>
    id === '1556344268099166319' ? log : null };
  let sqlArgs;
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['123', { channels }]]) }, db: {
    isDegraded: () => false, isAvailable: () => true,
    db: { pool: { query: async (_sql, params) => {
      sqlArgs = params;
      return { rows: [{ value: 119 }] };
    } } },
  } };
  assert.equal(await nextReportNumber(client, '123'), 119);
  assert.equal(sqlArgs[2], 118);
});

test('expired historical rows cannot reset a live report counter while Cloudy is running', async () => {
  const channel = { messages: { fetch: async () => ({
    size: 1,
    values: () => [{ id: 'last', author: { id: 'bot' }, embeds: [{ title: 'New report #112' }] }].values(),
    last: () => ({ id: 'last' }),
  }) } };
  const guild = { channels: { cache: new Map([['1554538663512248350', channel]]), fetch: async () => null } };
  const floors = [];
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['123', guild]]) }, db: {
    isDegraded: () => false, isAvailable: () => true,
    db: { pool: { query: async (_sql, params) => {
      floors.push(params[2]);
      return { rows: [{ value: floors.length === 1 ? 113 : 114 }] };
    } } },
  } };
  assert.equal(await nextReportNumber(client, '123'), 113);
  assert.equal(await nextReportNumber(client, '123'), 114);
  assert.deepEqual(floors, [112, 113]);
});
