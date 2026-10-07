import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTicketCreatorAccess } from '../src/interactions/modals/ticket/createTicketUi.js';

test('ticket creation reuses the modal GuildMember and skips a slow member fetch', async () => {
  const actor = { id: 'creator', roles: { cache: new Map() } };
  let checks = 0;
  const channel = {
    guild: { id: 'guild', members: {
      cache: new Map(),
      fetch: async () => assert.fail('The interaction actor is already known'),
    } },
    permissionsFor: member => {
      assert.equal(member, actor);
      checks++;
      return { has: () => true };
    },
    permissionOverwrites: { edit: async () => assert.fail('Already correct access must not be rewritten') },
  };
  assert.equal(await ensureTicketCreatorAccess(channel, 'creator', actor), true);
  assert.equal(checks, 1);
});

test('ticket access still repairs missing permissions and never trusts a mismatched actor', async () => {
  let fetches = 0;
  const writes = [];
  const channel = {
    guild: {
      id: 'guild',
      members: {
        cache: new Map(),
        fetch: async id => { fetches++; return { id }; },
      },
    },
    permissionsFor: member => {
      assert.equal(member.id, 'creator');
      return { has: () => false };
    },
    permissionOverwrites: {
      edit: async (id, permissions) => writes.push({ id, permissions }),
    },
  };
  assert.equal(await ensureTicketCreatorAccess(channel, 'creator', { id: 'unrelated' }), true);
  assert.equal(fetches, 1);
  assert.deepEqual(writes, [{ id: 'creator', permissions: {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  } }]);
});
