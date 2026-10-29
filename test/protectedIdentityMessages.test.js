import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { enforceProtectedIdentityMessage, enforceProtectedIdentityProfile } from '../src/services/protectedIdentityService.js';
import messageUpdate from '../src/events/messageUpdate.js';

function fixture(content, { guildId = '1532882647838228723', id = 'member' } = {}) {
  const actions = [];
  const guild = {
    id: guildId, ownerId: 'owner',
    channels: { cache: new Collection(), fetch: async () => null },
    members: { me: { permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) } },
  };
  const client = { user: { id: 'cloudy' }, channels: { fetch: async () => null }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  const user = { id, username: 'member', tag: 'member#0001' };
  const member = { id, user, guild, client, bannable: true,
    ban: async options => { actions.push({ ban: options.reason }); } };
  const message = { id: '1532882647838228900', guild, client, member, author: user, content,
    delete: async () => { actions.push('delete'); } };
  return { message, member, actions };
}

for (const content of ['Miro', 'miro!', 'PIAZZINI', 'Hey, Piazzini.', 'Míro', 'Doriane Miro', 'Dylano Piazzini']) {
  test(`blocked message name ${JSON.stringify(content)} deletes the message and bans its author`, async () => {
    const f = fixture(content);
    assert.equal(await enforceProtectedIdentityMessage(f.message), true);
    assert.equal(f.actions[0], 'delete');
    assert.equal(f.actions.length, 2);
    assert.match(f.actions[1].ban, /blocked identity detected \((?:Miro|Piazzini|Doriane Miro|Dylano Piazzini)\)/);
  });
}

for (const content of ['a mirror', 'amiro', 'piazzinix', 'normal message']) {
  test(`ordinary message ${JSON.stringify(content)} is left alone`, async () => {
    const f = fixture(content);
    assert.equal(await enforceProtectedIdentityMessage(f.message), false);
    assert.deepEqual(f.actions, []);
  });
}

test('message name rule keeps the existing guild and owner exemptions', async () => {
  for (const options of [{ guildId: 'another-guild' }, { id: 'owner' }, { id: 'cloudy' }]) {
    const f = fixture('Miro Piazzini', options);
    assert.equal(await enforceProtectedIdentityMessage(f.message), false);
    assert.deepEqual(f.actions, []);
  }
});

test('adding message names does not broaden the existing profile ban rule', async () => {
  const f = fixture('');
  f.member.displayName = 'Miro';
  assert.equal(await enforceProtectedIdentityProfile(f.member), false);
  assert.deepEqual(f.actions, []);
});

test('editing a normal message to a blocked name is enforced as well', async () => {
  const f = fixture('Piazzini');
  await messageUpdate.execute({ ...f.message, content: 'hello' }, f.message);
  assert.equal(f.actions[0], 'delete');
  assert.equal(f.actions.length, 2);
  assert.match(f.actions[1].ban, /Piazzini/);
});
