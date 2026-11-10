import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageSnapshot, shouldSnapshotMessage } from '../src/services/messageSnapshotService.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';

function reportNotice(title, authorId = 'cloudy') {
  return {
    id: '1569500000000000089',
    guildId: 'test-report-guild',
    guild: { id: 'test-report-guild', fetchAuditLogs: async () => {
      throw new Error('private report disposal must not query audit logs');
    } },
    channelId: 'private-report-room',
    client: { user: { id: 'cloudy' } },
    author: { id: authorId, bot: authorId === 'cloudy' },
    partial: false,
    content: '',
    embeds: [{ title }],
    components: [],
  };
}

test('report notification snapshot preserves a private-report marker without confidential content', () => {
  const reporter = reportNotice('Report n•89 update');
  const reported = reportNotice('Moderation n•89 update');
  for (const message of [reporter, reported]) {
    assert.equal(shouldSnapshotMessage(message), true);
    const snapshot = buildMessageSnapshot(message);
    assert.equal(snapshot.privateReport, true);
    assert.equal(snapshot.content, undefined, 'no private report description is stored in message logs');
    assert.equal(snapshot.authorId, 'cloudy');
  }
});

test('report close and expiry logs are classified as system notices, not normal deleted messages', () => {
  for (const title of ['Report n•89 closed', 'Moderation n•89 automatically deleted']) {
    assert.equal(buildMessageSnapshot(reportNotice(title)).privateReport, true);
  }
  assert.notEqual(buildMessageSnapshot(reportNotice('New report #89')).privateReport, true,
    'the main staff report is not a private outcome notice');
  assert.notEqual(buildMessageSnapshot(reportNotice('Report n•89 update', 'member')).privateReport, true,
    'a member cannot spoof the bot-only suppression marker');
});

test('deleting a private outcome produces no duplicate generic deletion log, including after cache loss', async () => {
  const live = reportNotice('Report n•89 update');
  const snapshot = buildMessageSnapshot(live);
  await assert.doesNotReject(logDeletedMessage(live));
  const partial = { ...live, partial: true, author: null, embeds: [], components: [] };
  await assert.doesNotReject(logDeletedMessage(partial, { snapshot }));
});
