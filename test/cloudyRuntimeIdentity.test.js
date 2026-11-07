import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { resolvePostgresPoolConfig } from '../src/config/database/postgres.js';

test('Cloudy response patching is idempotent and uses the Cloudy interaction marker', async () => {
  const calls = [];
  const interaction = {id: '1532882647838229001', user: {id: 'owner'}, createdTimestamp: Date.now(),
    isChatInputCommand: () => true, commandName: 'help',
    reply: async payload => {calls.push(payload); return payload;},
    editReply: async payload => payload, followUp: async payload => payload};
  InteractionHelper.patchInteractionResponses(interaction);
  const once = interaction.reply;
  InteractionHelper.patchInteractionResponses(interaction);
  assert.equal(interaction.__cloudyResponsePatched, true);
  assert.equal(interaction.reply, once);
  await interaction.reply({content: 'Cloudy'});
  assert.deepEqual(calls, [{content: 'Cloudy'}]);
});

function clearDatabaseLocation(t) {
  for (const key of ['POSTGRES_URL', 'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'POSTGRES_DB', 'PGDATABASE']) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {if (previous === undefined) delete process.env[key]; else process.env[key] = previous;});
  }
}

test('new local installations use the Cloudy database default', t => {
  clearDatabaseLocation(t);
  assert.equal(resolvePostgresPoolConfig().database, 'cloudy');
});

test('an explicitly configured existing database keeps its exact name and URL', t => {
  clearDatabaseLocation(t);
  process.env.POSTGRES_DB = 'owner_existing_database';
  assert.equal(resolvePostgresPoolConfig().database, 'owner_existing_database');
  process.env.POSTGRES_URL = 'postgresql://owner:example@localhost:5432/owner_existing_database';
  assert.equal(resolvePostgresPoolConfig().connectionString, 'postgresql://owner:example@localhost:5432/owner_existing_database');
});
