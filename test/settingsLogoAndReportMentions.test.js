import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('saved Builder logo setting does not add a C logo without explicit user choice', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const hydrationFunctions = [
    'export function loadRecordSnapshotIntoState',
    'function loadEmbedIntoState',
  ];
  const expressions = [
    /state\.showLogo = Boolean\(displayThumbnail\?\.url\);/,
    /state\.showLogo = Boolean\(data\.thumbnail\?\.url\);/,
  ];

  for (let index = 0; index < hydrationFunctions.length; index += 1) {
    const name = hydrationFunctions[index];
    const start = source.indexOf(name);
    assert.ok(start >= 0, `${name} must continue to load settings messages`);
    const nextFunction = source.indexOf('\nfunction ', start + name.length);
    const body = source.slice(start, nextFunction < 0 ? undefined : nextFunction);
    assert.match(body, expressions[index]);
    assert.match(body, /state\.removeExistingLogo = false;/);
  }
});

test('participant report notifications mention only their recipient while New report keeps its staff alert', () => {
  const lifecycle = fs.readFileSync('src/services/reportCaseLifecycleService.js', 'utf8');
  const publishStart = lifecycle.indexOf('export async function publishReportOutcome');
  const publishEnd = lifecycle.indexOf('\nfunction clearTimers', publishStart);
  const publishBody = lifecycle.slice(publishStart, publishEnd);
  assert.match(publishBody, /content: `<@\$\{participant\}>`/);
  assert.match(publishBody, /allowedMentions: \{ parse: \[\], users: \[participant\], roles: \[\] \}/);
  assert.doesNotMatch(publishBody, /<@&\$\{/);

  const contextReport = fs.readFileSync('src/commands/Utility/reportMessage.js', 'utf8');
  assert.match(contextReport, /title: `New report #\$\{reportNumber\}`/);
  assert.match(contextReport, /content: staffRoleId \? `<@&\$\{staffRoleId\}>` : null/);
});
