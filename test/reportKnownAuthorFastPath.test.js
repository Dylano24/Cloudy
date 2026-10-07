import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserAuthor } from '../src/utils/logging/logEmbeds.js';

test('message context reports reuse the supplied Discord author without another lookup', async () => {
  const knownUser = {
    id: 'known-user',
    tag: 'CloudyMember#1234',
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/test.png',
  };
  const client = { users: { fetch: async () => assert.fail('Unexpected REST user lookup') } };
  const author = await resolveUserAuthor(client, knownUser.id, knownUser);
  assert.deepEqual(author, {
    name: 'CloudyMember#1234',
    iconURL: 'https://cdn.discordapp.com/avatars/test.png',
  });
});

test('missing or mismatched user snapshot still uses the existing lookup', async () => {
  let lookups = 0;
  const client = { users: { fetch: async id => {
    lookups += 1;
    return { tag: id, displayAvatarURL: () => 'https://cdn.discordapp.com/fallback.png' };
  } } };
  const knownUser = { id: 'old-user', tag: 'Old', displayAvatarURL: () => 'old' };
  const author = await resolveUserAuthor(client, 'requested-user', knownUser);
  assert.equal(lookups, 1);
  assert.equal(author.name, 'requested-user');
});
