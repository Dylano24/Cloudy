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
    assert.match(source, /title: `New report #\$\{reportNumber\}`/);
    assert.doesNotMatch(source, /title: 'New report'/);
    assert.doesNotMatch(source, /name: 'Report'[\s\S]{0,120}value: `#\$\{reportNumber\}`/);
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

test('report logs are informational only and private reports own Delete report', () => {
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
  assert.match(source, /setLabel\('Read'\)/);
  assert.match(source, /ButtonStyle\.Secondary/);
  assert.match(source, /This report has been read by/);
  assert.match(source, /\*\*Thank you\.\*\*\\nWe have been informed that you have read this report\./);
  assert.match(source, /color: CLOUDY_GREEN_COLOR/);
  assert.match(source, /10_000/);
  assert.match(source, /title: 'Delete report'/);
  assert.match(source, /Only the staff can delete this report\./);
  assert.match(source, /title: 'Report notification'/);
  assert.match(source, /'Report closed'/);
  assert.match(source, /'Report deleted'/);
  assert.match(source, /'Report created'/);
  assert.match(source, /publishStaffLog\(client, guild, record, audience, 'created', actorId\)/);
  assert.doesNotMatch(source, /title: 'Report case notification'/);
  assert.doesNotMatch(source, /title: 'Delete case'/);
  assert.match(source, /color: CLOUDY_RED_COLOR/);
});


test('report lifecycle embeds use compact Report + hash-number presentation', () => {
  const lifecycle = fs.readFileSync('src/services/reportCaseLifecycleService.js', 'utf8');
  const matches = lifecycle.match(/name: 'Report', value: `#\$\{record\.number\}`, inline: true/g) || [];
  assert.equal(matches.length, 3);
  assert.doesNotMatch(lifecycle, /name: 'Case'/);
  assert.doesNotMatch(lifecycle, /value: `report-\$\{record\.number\}`/);

  // Report handled keeps its existing presentation; New report carries the number in its title.
  const actions = fs.readFileSync('src/services/reportActionService.js', 'utf8');
  assert.match(actions, /name: `Report #\$\{record\.number\}`, value: '\\u200B'/);
});
