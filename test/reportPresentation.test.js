import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildReportActions, reportActionText } from '../src/services/reportActionService.js';

test('every newly filed report gets its number before the original report is sent', () => {
  for (const file of [
    'src/commands/Utility/reportMessage.js',
    'src/commands/Utility/modules/report.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    const numberAt = source.indexOf('nextReportNumber(');
    const sendAt = source.indexOf('logEvent({');
    assert.ok(numberAt >= 0 && sendAt > numberAt, `${file} must reserve the number before logEvent`);
    assert.match(source, /New report • #\$\{reportNumber\}/);
    assert.match(source, /name: 'Report'[\s\S]*Report #\$\{reportNumber\}/);
    assert.match(source, /number: reportNumber/);
  }
});

test('report action controls expose no-sanction and both requested combined actions', () => {
  const rows = buildReportActions('target').map(row => row.toJSON().components.map(button => button.label));
  assert.deepEqual(rows[0], ['Delete', 'Timeout', 'Ban', 'No sanction']);
  assert.deepEqual(rows[1], ['Delete + timeout', 'Delete + ban']);
  assert.equal(
    reportActionText(['delete', 'timeout']),
    'The reported message has been deleted.\nThe reported member has been timed out.',
  );
});

test('report handling uses one clear handled summary with actor and timestamp', () => {
  const source = fs.readFileSync('src/services/reportActionService.js', 'utf8');
  assert.match(source, /title: 'Report handled'/);
  assert.match(source, /name: 'Handled by'/);
  assert.match(source, /name: 'Handled at'/);
  assert.doesNotMatch(source, /title: 'Success'/);
});

test('player report notifications never tag Staff', () => {
  const source = fs.readFileSync('src/services/reportCaseLifecycleService.js', 'utf8');
  const start = source.indexOf('export async function publishReportOutcome');
  const end = source.indexOf('\nfunction clearTimers', start);
  const body = source.slice(start, end);
  assert.match(body, /content: `<@\$\{participant\}>`/);
  assert.match(body, /allowedMentions: \{ parse: \[\], users: \[participant\], roles: \[\] \}/);
  assert.doesNotMatch(body, /<@&\$\{staffId\}>/);
  assert.doesNotMatch(body, /name: 'Handled by'/);
});
