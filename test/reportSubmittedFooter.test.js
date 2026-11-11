import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEmbed } from '../src/utils/embeds.js';
import { buildReportSubmittedEmbed } from '../src/utils/reportSubmittedEmbed.js';
import { withCloudyFooter, withReportSubmittedNumber, ensureOutgoingReportConfirmationFooter, withReportCaseNoticeNumber, ensureOutgoingReportCaseNoticeFooter } from '../src/utils/cloudyFooter.js';
import { normalizeCloudyEmbed } from '../src/services/cloudyBrandingService.js';
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
    }).toJSON();
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

test('numbered report confirmation cannot be overwritten by global Cloudy normalization', () => {
  const embed = buildReportSubmittedEmbed({
    reportNumber: 110,
    reportedMemberId: '123456789012345678',
    reportedMessageText: 'X',
    reason: 'Tyt',
  });
  const normalized = normalizeCloudyEmbed(embed, { ensureFooter: true });
  assert.equal(normalized.changed, false);
  assert.equal(normalized.embed.toJSON().footer.text, 'Cloudy Inc. • Moderation team • R110');
  const outgoing = withCloudyFooter({ embeds: [normalized.embed] });
  assert.equal(outgoing.embeds[0].toJSON().footer.text, 'Cloudy Inc. • Moderation team • R110');
});

test('final Discord REST payload repairs incorrect Report submitted footer using the actual number', async () => {
  const render = async number => withReportSubmittedNumber(number, async () => {
    await Promise.resolve();
    const outdated = { embeds: [{ title: 'Report submitted', footer: {
      text: '© Cloudy Inc. • Quality. Innovation. Performance.',
    }, fields: [{ name: 'Reported message', value: 'X' }] }] };
    const result = ensureOutgoingReportConfirmationFooter(withCloudyFooter(outdated));
    assert.equal(result.embeds[0].footer.text, `Cloudy Inc. • Moderation team • R${number}`);
    assert.deepEqual(result.embeds[0].fields, [{ name: 'Reported message', value: 'X' }]);
    return result;
  });
  const responses = await Promise.all([render(110), render(111)]);
  assert.equal(responses[0].embeds[0].footer.text, 'Cloudy Inc. • Moderation team • R110');
  assert.equal(responses[1].embeds[0].footer.text, 'Cloudy Inc. • Moderation team • R111');
  assert.deepEqual(ensureOutgoingReportConfirmationFooter({ embeds: [{ title: 'Report submitted' }] }),
    { embeds: [{ title: 'Report submitted' }] }, 'unscoped embeds remain untouched');
  assert.deepEqual(await withReportSubmittedNumber(112, async () =>
    ensureOutgoingReportConfirmationFooter({ embeds: [{ title: 'Moderation update' }] })),
    { embeds: [{ title: 'Moderation update' }] }, 'private moderation updates remain untouched');
});

test('final REST branding cannot replace R113 with stale R103 and R106 across private reports', async () => {
  const make = async (title, oldNumber) =>
    withReportCaseNoticeNumber(113, async () => {
      await Promise.resolve();
      return ensureOutgoingReportCaseNoticeFooter(withCloudyFooter({
        embeds: [{ title, description: 'Existing body', footer: {
          text: `Cloudy Inc. • Moderation team • R${oldNumber}`,
        } }],
      }));
    });
  const [reporter, target] = await Promise.all([
    make('Report update', 106), make('Moderation update', 103),
  ]);
  for (const result of [reporter, target]) {
    assert.equal(result.embeds[0].footer.text, 'Cloudy Inc. • Moderation team • R113');
    assert.equal(result.embeds[0].description, 'Existing body');
  }
  assert.equal(ensureOutgoingReportCaseNoticeFooter({
    embeds: [{ title: 'Report update', footer: { text: 'R103' } }],
  }).embeds[0].footer.text, 'R103', 'outside scoped notice only original footer remains');
});
