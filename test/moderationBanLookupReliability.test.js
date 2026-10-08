import test from 'node:test';
import assert from 'node:assert/strict';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { db } from '../src/utils/database.js';

function fixture(t, fetch) {
  t.mock.method(db, 'get', async (_key, fallback) => structuredClone(fallback));
  t.mock.method(db, 'set', async () => true);
  const unban = t.mock.fn(async () => true);
  return {
    guild: { id: 'ban-lookup', name: 'Server', client: {}, bans: { fetch }, members: { unban } },
    user: { id: '123456789012345678', tag: 'Member' },
    moderator: { id: 'staff', user: { tag: 'Staff' } },
    unban,
  };
}

test('unban resolves only the requested current ban instead of fetching the whole ban list', async t => {
  const optionsSeen = [];
  const { guild, user, moderator, unban } = fixture(t, async options => {
    optionsSeen.push(options);
    assert.deepEqual(options, { user: '123456789012345678', force: true });
    return { user: { id: '123456789012345678' } };
  });

  const result = await ModerationService.unbanUser({ guild, user, moderator, reason: 'Reviewed' });

  assert.equal(optionsSeen.length, 1);
  assert.deepEqual(unban.mock.calls[0].arguments, [user.id, 'Reviewed']);
  assert.equal(result.user, user.tag);
  assert.equal(result.reason, 'Reviewed');
});

test('an absent requested ban retains the existing not-banned error', async t => {
  const { guild, user, moderator, unban } = fixture(t, async () => {
    throw Object.assign(new Error('Unknown ban'), { code: 10026 });
  });

  await assert.rejects(ModerationService.unbanUser({ guild, user, moderator }), error =>
    error.userMessage === `${user.tag} is not currently banned from this server`);
  assert.equal(unban.mock.callCount(), 0);
});
