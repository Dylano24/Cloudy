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
  assert.deepEqual(calls[0].params, ['global:report-counter:123', 'global:report:123:%']);
  assert.match(calls[0].sql, /MAX\(CASE/);
  assert.match(calls[0].sql, /value ->> 'number'/);
  assert.match(calls[0].sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(calls[0].sql, /GREATEST\(/);
  assert.match(calls[0].sql, /RETURNING value/);
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
