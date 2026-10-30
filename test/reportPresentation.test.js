import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildReportActions, handledReportEmbeds, reportActionText } from '../src/services/reportActionService.js';
import { reportCaseControls } from '../src/services/reportCaseService.js';

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

test('a handled report is marked in place: green, Handled by + Handled at instead of Submitted', () => {
  const report = { embeds: [{ toJSON: () => ({ title: 'New report #76', color: 0xFFFFFF, footer: { text: 'footer' }, fields: [
    { name: 'Reported member', value: '<@target>' }, { name: 'Reported by', value: '<@reporter>' }, { name: 'Reason', value: 'Spam' },
    { name: 'Evidence', value: 'Message' }, { name: 'Submitted', value: '<t:1:F>' }] }) }] };
  const [data] = handledReportEmbeds(report, 'staff', 1_800_000_000_000, ['delete', 'ban']);
  assert.equal(data.title, 'New report #76');
  assert.equal(data.color, 0x00C49D);
  assert.deepEqual(data.footer, { text: 'footer' });
  assert.deepEqual(data.fields.map(field => `${field.name}: ${field.value}`), [
    'Reported member: <@target>', 'Reported by: <@reporter>', 'Reason: Spam', 'Evidence: Message',
    'Report handled: The reported message has been deleted.\nThe reported member has been banned.',
    'Handled by: <@staff>', 'Handled at: <t:1800000000:F>',
  ]);
  // Marking it again never duplicates the handled lines.
  const again = handledReportEmbeds({ embeds: [data] }, 'staff', 1_800_000_000_000, ['delete', 'ban'])[0];
  assert.deepEqual(again.fields, data.fields);
  const source = fs.readFileSync('src/services/reportActionService.js', 'utf8');
  assert.doesNotMatch(source, /title: 'Report handled'/);
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
  const read = reportCaseControls({ messageId: 'report' })[0].toJSON().components[0];
  assert.equal(read.label, 'Read');
  assert.equal(read.style, 2);
  assert.equal(read.custom_id, 'report_case:read:report:target');
  assert.match(source, /This report has been read by/);
  assert.match(source, /title: 'Thank you\.'/);
  assert.match(source, /description: 'We have been informed that you have read this report\.'/);
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

});
