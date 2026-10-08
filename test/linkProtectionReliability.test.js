import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { enforceLinkProtection } from '../src/services/linkProtectionService.js';
import { resolveMessageDeleter } from '../src/services/deletionAttributionService.js';

function fixture({ content, id }) {
  const sent = [];
  const deleted = [];
  const timeouts = [];
  const client = { user: { id: 'cloudy' } };
  const guild = { id, channels: { cache: new Collection() } };
  const channel = {
    id: `${id}-channel`, name: 'general', viewable: true,
    isTextBased: () => true,
    send: async payload => {
      sent.push(payload);
      return { deletable: true, delete: async () => {} };
    },
    messages: { fetch: async () => new Collection() },
  };
  guild.channels.cache.set(channel.id, channel);
  const message = {
    id: `${id}-message`, content, client, guild, channel, channelId: channel.id,
    author: { id: `${id}-user`, tag: 'member' },
    member: {
      moderatable: true,
      permissions: { has: permission => permission === PermissionFlagsBits.ViewChannel },
      timeout: async (...args) => { timeouts.push(args); },
    },
    delete: async () => { deleted.push(message.id); },
  };
  return { message, sent, deleted, timeouts, channel };
}

test('wrong-channel links are removed and attributed to AutoMod', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ content: 'https://youtu.be/example', id: 'link-routing' });

  assert.equal(await enforceLinkProtection(f.message), true);
  assert.deepEqual(f.deleted, [f.message.id]);
  assert.equal((await resolveMessageDeleter(f.message)).source, 'automod');
  assert.equal(f.sent[0].embeds[0].data.title, 'Wrong channel');
  assert.equal(f.timeouts.length, 0);
});

test('link spam removes recent matching messages and retains the first offense timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ content: 'https://example.com/a https://example.com/b https://example.com/c', id: 'link-spam' });
  const recent = {
    ...f.message, id: 'previous-link', content: 'https://example.com/previous',
    createdTimestamp: Date.now(), deletable: true,
    delete: async () => { f.deleted.push('previous-link'); },
  };
  f.channel.messages.fetch = async () => new Collection([[recent.id, recent]]);

  assert.equal(await enforceLinkProtection(f.message), true);
  assert.deepEqual(f.deleted, [f.message.id, recent.id]);
  assert.equal((await resolveMessageDeleter(recent)).id, 'cloudy');
  assert.equal(f.timeouts[0][0], 60 * 60 * 1000);
  assert.equal(f.sent[0].embeds[0].data.title, 'Link spam detected');
});
