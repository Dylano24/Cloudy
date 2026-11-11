import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEmbed } from '../src/utils/embeds.js';
import { buildReportSubmittedEmbed } from '../src/utils/reportSubmittedEmbed.js';
import { withCloudyFooter } from '../src/utils/cloudyFooter.js';
import { CLOUDY_STANDARD_FOOTER, ensureReportSubmittedFooter } from '../src/utils/cloudyFooter.js';

test('Report submitted confirmation restores the standard footer below its existing Cloudy logo', () => {
  const confirmation = createEmbed({
    title: 'Report submitted',
    description: 'Report #4 has been sent to the staff team.',
    color: 'success',
  });
  const before = confirmation.toJSON();
  assert.ok(before.thumbnail?.url, 'existing top-right Cloudy logo must be preserved');
  const same = ensureReportSubmittedFooter(confirmation);
  assert.equal(same, confirmation);
  const after = confirmation.toJSON();
  assert.equal(after.footer?.text, CLOUDY_STANDARD_FOOTER);
  assert.equal(after.title, before.title);
  assert.equal(after.description, before.description);
  assert.equal(after.color, before.color);
  assert.deepEqual(after.thumbnail, before.thumbnail);
});

test('Report submitted footer preserves saved custom footer without making duplicates', () => {
  const confirmation = createEmbed({ title: 'Report submitted', description: 'Test' });
  confirmation.data.footer = { text: 'Custom saved footer' };
  ensureReportSubmittedFooter(confirmation);
  ensureReportSubmittedFooter(confirmation);
  assert.deepEqual(confirmation.toJSON().footer, { text: 'Custom saved footer' });
});

test('both submission routes use the same moderation confirmation and retain two-minute cleanup', () => {
  for (const file of [
    'src/commands/Utility/reportMessage.js',
    'src/commands/Utility/modules/report.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /buildReportSubmittedEmbed\(\{/);
    assert.match(source, /scheduleTicketReplyDeletion\([^\n]*120_000\)/);
  }
});

test('Cloudy report confirmation always sends the case-specific R-numbered moderation footer', () => {
  for (const number of [89, 107]) {
    const embed = buildReportSubmittedEmbed({
      reportNumber: number,
      reportedMemberId: '123456789012345678',
      reportedMessageText: 'Reported text',
      reason: 'Offensive content',
    });
    const footer = `Cloudy Inc. • Moderation team • R${number}`;
    assert.equal(embed.title, 'Report submitted');
    assert.equal(embed.footer?.text, footer);
    assert.equal(embed.fields[0].name, 'Reported member');
    assert.equal(embed.fields[1].value, 'Reported text');
    assert.equal(embed.fields[2].value, 'Offensive content');
    const outgoing = withCloudyFooter({ embeds: [embed] });
    const actual = outgoing.embeds[0]?.toJSON?.() || outgoing.embeds[0];
    assert.equal(actual.footer?.text, footer, 'Cloudy outgoing branding must preserve the numbered footer');
  }
});
