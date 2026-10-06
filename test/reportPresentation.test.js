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
    assert.match(source, /title: 'New report'/);
    assert.doesNotMatch(source, /New report • #\$\{reportNumber\}/);
    assert.match(source, /name: `Report #\$\{reportNumber\}`[\s\S]*value: '\\u200B'/);
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


test('report permission denial uses the requested owner wording, Cloudy embed and 10-second cleanup', () => {
  const source = fs.readFileSync('src/services/reportActionService.js', 'utf8');
  assert.match(source, /title: 'Permission denied'/);
  assert.match(source, /color: 'error'/);
  assert.match(source, /Only owners can ban members from reports\./);
  assert.doesNotMatch(source, /Only members with the Owner role can ban members from reports\./);
  assert.match(source, /10_000/);
});

test('report logs are informational only and private cases own Delete case', () => {
  const source = fs.readFileSync('src/services/reportCaseLifecycleService.js', 'utf8');
  const logStart = source.indexOf('function logEmbed(');
  const logEnd = source.indexOf('\nasync function publishStaffLog', logStart);
  const logBody = source.slice(logStart, logEnd);
  assert.doesNotMatch(logBody, /name: 'Channel'/);

  const publishStart = source.indexOf('async function publishStaffLog');
  const publishEnd = source.indexOf('\nasync function refreshLogControls', publishStart);
  const publishBody = source.slice(publishStart, publishEnd);
  assert.match(publishBody, /components: \[\]/);

  assert.match(source, /setLabel\('Delete'\)/);
  assert.match(source, /title: 'Delete case'/);
  assert.match(source, /Only the staff can delete this case\./);
  assert.match(source, /color: CLOUDY_RED_COLOR/);
});


test('report case embeds show the case number only once as the bold field name', () => {
  for (const file of [
    'src/services/reportCaseLifecycleService.js',
    'src/services/reportActionService.js',
    'src/commands/Utility/reportMessage.js',
    'src/commands/Utility/modules/report.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /name: 'Report',\s*value: `Report #\$\{/);
  }

  const lifecycle = fs.readFileSync('src/services/reportCaseLifecycleService.js', 'utf8');
  assert.match(lifecycle, /name: `Report #\$\{record\.number\}`, value: '\\u200B'/);

  const actions = fs.readFileSync('src/services/reportActionService.js', 'utf8');
  assert.match(actions, /name: `Report #\$\{record\.number\}`, value: '\\u200B'/);
});
