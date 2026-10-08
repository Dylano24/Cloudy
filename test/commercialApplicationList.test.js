import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import appAdmin from '../src/commands/Community/app-admin.js';

for (const code of ['ECONNRESET', 50013, 10007]) {
  test(`application list ${code === 10007 ? 'removes confirmed departed applicants' : `retains stored applicants after Discord ${code}`}`, async () => {
    const guildId = `application-list-${code}`;
    const appKey = `guild:${guildId}:applications:application-id`;
    const app = { id: 'application-id', userId: 'applicant', roleName: 'Moderator', username: 'Applicant', status: 'pending', createdAt: Date.now() };
    const records = new Map([[appKey, app]]);
    const deleted = [];
    let reply;
    const client = { db: {
      get: async (key, fallback) => records.has(key) ? structuredClone(records.get(key)) : fallback,
      list: async prefix => [...records.keys()].filter(key => key.startsWith(prefix)),
      set: async (key, value) => { records.set(key, value); return true; },
      delete: async key => { deleted.push(key); records.delete(key); return true; },
    } };
    await appAdmin.execute({
      id: guildId, guildId, client, createdTimestamp: Date.now(), deferred: true,
      inGuild: () => true, user: { id: 'manager' },
      member: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), roles: { cache: new Collection() } },
      guild: { id: guildId, members: { fetch: async () => { throw Object.assign(new Error('Discord fetch failure'), { code }); } }, roles: { cache: new Collection() } },
      options: { getSubcommand: () => 'list', getString: () => null, getUser: () => null, getNumber: () => null },
      editReply: async payload => { reply = payload; },
    });
    if (code === 10007) {
      assert.deepEqual(deleted, [appKey]);
      assert.equal(records.has(appKey), false);
    } else {
      assert.deepEqual(deleted, []);
      assert.deepEqual(records.get(appKey), app);
      assert.equal(reply.embeds[0].toJSON().title, 'Submitted Applications');
    }
  });
}
