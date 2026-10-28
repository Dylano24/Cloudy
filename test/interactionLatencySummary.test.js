import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emitInteractionLatencySummary,
  observeInteractionLatency,
  recordSlowInteractionCompletion,
  takeInteractionLatencySummary,
} from '../src/utils/interactionLatency.js';

test('fast and slow samples both reach the windowed median/p95 summary, without IDs', async () => {
  takeInteractionLatencySummary();
  for (const ms of [100, 200, 300, 400, 2000]) {
    recordSlowInteractionCompletion({ commandName: 'pay' }, ms, { report: () => {} });
  }
  let now = 0;
  const interaction = { customId: 'report_case:read:123456789012345678:target', deferUpdate: async () => {} };
  observeInteractionLatency(interaction, { now: () => now, report: () => {} });
  now = 120;
  await interaction.deferUpdate();
  const rows = takeInteractionLatencySummary();
  assert.deepEqual(rows.find(row => row.command === 'pay'),
    { command: 'pay', phase: 'handler_complete', n: 5, p50Ms: 300, p95Ms: 2000, maxMs: 2000 });
  assert.deepEqual(rows.find(row => row.command === 'report_case'),
    { command: 'report_case', action: 'read', phase: 'ack', n: 1, p50Ms: 120, p95Ms: 120, maxMs: 120 });
  assert.equal(JSON.stringify(rows).includes('123456789012345678'), false);
  assert.deepEqual(takeInteractionLatencySummary(), [], 'each window starts empty');
});

test('the FAQ assistant stays excluded and an empty window logs nothing', () => {
  takeInteractionLatencySummary();
  recordSlowInteractionCompletion({ customId: 'faq_ai_question_modal' }, 9000, { report: () => {} });
  const reports = [];
  emitInteractionLatencySummary({ report: data => reports.push(data) });
  assert.deepEqual(reports, []);
  recordSlowInteractionCompletion({ commandName: 'balance' }, 640, { report: () => {} });
  emitInteractionLatencySummary({ report: data => reports.push(data) });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].event, 'interaction.latency.summary');
  assert.deepEqual(reports[0].rows.map(row => row.command), ['balance']);
});

test('a failing summary logger can never affect interactions', () => {
  recordSlowInteractionCompletion({ commandName: 'work' }, 10, { report: () => {} });
  assert.doesNotThrow(() => emitInteractionLatencySummary({ report: () => { throw new Error('log down'); } }));
});
