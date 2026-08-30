import test from 'node:test';
import assert from 'node:assert/strict';
import {
  embedReferencesUser,
  shouldSyncProfileThumbnail,
} from '../src/services/profileAvatarSyncService.js';

const USER_ID = '123456789012345678';

test('custom Discord avatar thumbnail is recognized as belonging to the user', () => {
  const embed = {
    title: 'Kick Log',
    description: '**User:** <@123456789012345678> (Example)',
    thumbnail: {
      url: 'https://cdn.discordapp.com/avatars/123456789012345678/oldhash.webp?size=256',
    },
  };

  assert.equal(
    shouldSyncProfileThumbnail(
      embed,
      USER_ID,
      'https://cdn.discordapp.com/avatars/123456789012345678/oldhash.webp?size=256',
    ),
    true,
  );
});

test('default avatar requires the embed to reference the same user', () => {
  const oldAvatar = 'https://cdn.discordapp.com/embed/avatars/2.png?size=256';
  const matching = {
    fields: [{ name: 'Member', value: '<@123456789012345678>\nID: `123456789012345678`' }],
    thumbnail: { url: oldAvatar },
  };
  const unrelated = {
    fields: [{ name: 'Member', value: '<@999999999999999999>' }],
    thumbnail: { url: oldAvatar },
  };

  assert.equal(embedReferencesUser(matching, USER_ID), true);
  assert.equal(shouldSyncProfileThumbnail(matching, USER_ID, oldAvatar), true);
  assert.equal(shouldSyncProfileThumbnail(unrelated, USER_ID, oldAvatar), false);
});

test('unrelated thumbnails are never replaced just because the user is mentioned', () => {
  const embed = {
    description: '**User:** <@123456789012345678>',
    thumbnail: { url: 'https://example.com/cloudy-logo.png' },
  };

  assert.equal(
    shouldSyncProfileThumbnail(
      embed,
      USER_ID,
      'https://cdn.discordapp.com/avatars/123456789012345678/oldhash.webp?size=256',
    ),
    false,
  );
});

test('server profile avatar CDN paths are recognized for the same user', () => {
  const embed = {
    thumbnail: {
      url: 'https://cdn.discordapp.com/guilds/111111111111111111/users/123456789012345678/avatars/serverhash.webp?size=256',
    },
  };

  assert.equal(
    shouldSyncProfileThumbnail(
      embed,
      USER_ID,
      'https://cdn.discordapp.com/guilds/111111111111111111/users/123456789012345678/avatars/serverhash.webp?size=256',
    ),
    true,
  );
});
