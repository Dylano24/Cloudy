import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseDisplayRecords, contentCreatorGuideRecordIdentity } from '../src/services/embedManagerService.js';

test('same-looking YouTube, Twitch and TikTok embeds have separate editable identities', () => {
  const platforms = ['youtube', 'twitch', 'tiktok'];
  const records = platforms.map((platform, i) => ({
    guildId: '123', channelId: String(1000 + i), channelName: `🔗 │ ${platform}`,
    messageId: String(9000 + i), embedIndex: 0, source: 'content-creators',
    title: 'Content Creators', name: 'Content Creators',
    snapshot: { title: 'Content Creators', description: 'Same text', color: 0xffffff },
  }));
  const groups = collapseDisplayRecords(records);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => !group.templateMode));
  assert.equal(new Set(records.map(contentCreatorGuideRecordIdentity)).size, 3);
  assert.deepEqual(groups.map(group => group.messageId), ['9000','9001','9002']);
  records[0].snapshot.description = 'YouTube only';
  assert.equal(records[1].snapshot.description, 'Same text');
  assert.equal(records[2].snapshot.description, 'Same text');
  assert.equal(contentCreatorGuideRecordIdentity({
    ...records[0], snapshot: { title: 'A custom title for YouTube' },
  }), 'content-creators:1000');
  assert.equal(contentCreatorGuideRecordIdentity({ ...records[0], channelName: 'general' }), null);
});
