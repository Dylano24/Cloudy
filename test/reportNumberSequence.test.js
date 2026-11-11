import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReportNumber } from '../src/services/reportCaseService.js';

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
  assert.match(calls[0].sql, /MAX\(\(value ->> 'number'\)::bigint\)/);
  assert.match(calls[0].sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(calls[0].sql, /GREATEST\(/);
  assert.match(calls[0].sql, /RETURNING value/);
});
