import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import { Collection, PermissionsBitField, ModalSubmitFields } from 'discord.js';
import { handleReactionRolesSelectMenu } from '../src/handlers/interactionHandlers/reactionRolesSelectMenu.js';
import nextBirthdays from '../src/commands/Birthday/modules/next_birthdays.js';
import calculateModal from '../src/handlers/calculateModals.js';
import { calculationContexts } from '../src/commands/Tools/calculate.js';
import generatePassword from '../src/commands/Tools/generatepassword.js';
import { warningClearAllHandler } from '../src/handlers/warningHandlers.js';
import hexColor from '../src/commands/Tools/hexcolor.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function relocatedModule(t, sourcePath) {
  const directory = await mkdtemp(join(root, '.tmp', 'command-path #percent%-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(root, sourcePath);
  const targetFile = join(directory, sourcePath);
  await mkdir(dirname(targetFile), { recursive: true });
  const source = (await readFile(sourceFile, 'utf8')).replace(
    /(from\s+['"])(\.[^'"]+)(['"])/g,
    (_, before, specifier, after) => `${before}${pathToFileURL(resolve(dirname(sourceFile), specifier)).href}${after}`,
  );
  await writeFile(targetFile, source);
  return { directory, module: await import(pathToFileURL(targetFile).href) };
}

test('event loader executes files from paths containing spaces, # and %', async t => {
  const fixture = await relocatedModule(t, 'src/handlers/loaders/events.js');
  const events = join(fixture.directory, 'src/events');
  await mkdir(events, { recursive: true });
  await writeFile(join(events, 'ready #percent%.js'),
    "export default { name: 'fixtureReady', once: true, execute(client) { client.executions++; } };\n");
  const client = new EventEmitter();
  client.executions = 0;
  await fixture.module.default(client);
  client.emit('fixtureReady');
  client.emit('fixtureReady');
  assert.equal(client.executions, 1);
});

test('help lists real command modules from paths containing spaces, # and %', async t => {
  const fixture = await relocatedModule(t, 'src/handlers/help/helpSelectMenus.js');
  const commands = join(fixture.directory, 'src/commands/Birthday');
  await mkdir(commands, { recursive: true });
  await writeFile(join(commands, 'birthday #percent%.js'),
    "export default { data: { name: 'birthday', description: 'Fixture birthday', options: [] } };\n");
  const client = { application: { commands: { fetch: async () => new Collection() } } };
  const viewer = { memberPermissions: new PermissionsBitField('Administrator') };
  const all = await fixture.module.createAllCommandsMenu(1, client, viewer);
  assert.match(all.embeds[0].toJSON().fields[0].value, /`\/birthday`/);
  let reply;
  await fixture.module.helpCategorySelectMenu.execute({
    ...viewer,
    values: ['Birthday'], deferred: true,
    editReply: async payload => { reply = payload; },
  }, client);
  assert.match(reply.embeds[0].toJSON().fields[0].value, /Fixture birthday/);
});

function reactionRoleFixture(permission) {
  const guildId = '123456789012345678';
  const messageId = '223456789012345678';
  const roleId = '323456789012345678';
  const role = { id: roleId, name: 'Selectable', managed: false, position: 1,
    permissions: new PermissionsBitField(permission) };
  const assigned = new Collection();
  const payloads = [];
  const member = { user: { id: '423456789012345678', tag: 'Player' }, roles: {
    cache: assigned,
    add: async added => { assigned.set(added.id, added); },
    remove: async removed => { assigned.delete(removed.id); },
  } };
  const guild = { id: guildId, roles: { cache: new Collection([[roleId, role]]) },
    members: { me: { permissions: new PermissionsBitField('ManageRoles'), roles: { highest: { position: 10 } } } } };
  const interaction = { id: 'reaction-role-safety', guildId, guild, member,
    user: member.user, message: { id: messageId }, values: [roleId],
    createdTimestamp: Date.now(), deferred: true, inGuild: () => true,
    editReply: async payload => { payloads.push(payload); } };
  const client = { guilds: { cache: new Collection(), fetch: async () => null }, db: { get: async key => {
    assert.equal(key, `guild:${guildId}:reaction_roles:${messageId}`);
    return { roles: [roleId] };
  } } };
  return { interaction, client, assigned, roleId, payloads };
}

for (const permission of ['ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'MentionEveryone']) {
  test(`reaction-role select cannot grant a role with ${permission} alone`, async () => {
    const f = reactionRoleFixture(permission);
    await handleReactionRolesSelectMenu(f.interaction, f.client);
    assert.equal(f.assigned.has(f.roleId), false);
    assert.match(f.payloads[0].embeds[0].toJSON().description, /Skipped/);
  });
}

test('reaction-role select still grants ordinary roles below the bot', async () => {
  const f = reactionRoleFixture('ViewChannel');
  await handleReactionRolesSelectMenu(f.interaction, f.client);
  assert.equal(f.assigned.has(f.roleId), true);
  assert.match(f.payloads[0].embeds[0].toJSON().description, /Added/);
});

function birthdayFixture(error) {
  const guildId = 'birthday-safety-guild';
  const birthday = { 'member-id': { month: 12, day: 10 } };
  let stored = structuredClone(birthday);
  const interaction = { id: 'birthday-safety', guildId, user: { id: 'requester' },
    deferred: true, createdTimestamp: Date.now(),
    guild: { name: 'Birthday guild', members: { fetch: async () => { throw error; } } },
    editReply: async () => {} };
  const client = { db: { get: async () => structuredClone(stored),
    set: async (_key, value) => { stored = structuredClone(value); return true; } } };
  return { client, interaction, birthday, stored: () => stored };
}

for (const code of ['ECONNRESET', 50013, 10007]) {
  test(`upcoming birthdays ${code === 10007 ? 'remove confirmed departed members' : `preserve stored birthdays after ${code}`}`, async () => {
    const f = birthdayFixture(Object.assign(new Error('Member fetch failed'), { code }));
    await nextBirthdays.execute(f.interaction, {}, f.client);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.deepEqual(f.stored(), code === 10007 ? {} : f.birthday);
  });
}

test('calculator modal reads Discord modal fields and evaluates the selected operation', async t => {
  const contextKey = 'commercial-calculation-context';
  calculationContexts.set(contextKey, { expression: '2 + 2', operator: '+', userId: 'calculator-user' });
  t.after(() => calculationContexts.delete(contextKey));
  const payloads = [];
  const interaction = {
    id: 'calculator-modal-safety', createdTimestamp: Date.now(),
    user: { id: 'calculator-user' }, deferred: false, replied: false,
    fields: new ModalSubmitFields([{ type: 1, components: [{
      type: 4, customId: `operand:${contextKey}`, value: '3',
    }] }]),
    deferReply: async () => { interaction.deferred = true; },
    editReply: async payload => { payloads.push(payload); },
    reply: async payload => { payloads.push(payload); },
  };
  await calculateModal.execute(interaction, {}, ['add']);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].embeds[0].toJSON().description, '`(2 + 2) + (3)` = `7`');
  assert.equal(calculationContexts.has(contextKey), false);
});

test('generated password retains every requested character category when random repairs collide', async t => {
  t.mock.method(webcrypto, 'getRandomValues', values => values.fill(0));
  t.mock.method(Math, 'random', () => 0);
  let reply;
  await generatePassword.execute({
    id: 'password-safety', user: { id: 'password-user' }, deferred: true,
    createdTimestamp: Date.now(),
    options: { getInteger: () => 8, getBoolean: () => true },
    editReply: async payload => { reply = payload; },
  });
  const password = reply.embeds[0].toJSON().description.match(/\*\*Password:\*\* \|\|`([^`]+)`\|\|/)[1];
  assert.equal(password.length, 8);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[^a-zA-Z0-9]/);
});

test('generated password honors excluded character categories and requested length', async () => {
  let reply;
  await generatePassword.execute({
    id: 'password-lowercase-safety', user: { id: 'password-user' }, deferred: true,
    createdTimestamp: Date.now(),
    options: { getInteger: () => 50, getBoolean: () => false },
    editReply: async payload => { reply = payload; },
  });
  const password = reply.embeds[0].toJSON().description.match(/\*\*Password:\*\* \|\|`([^`]+)`\|\|/)[1];
  assert.match(password, /^[a-z]{50}$/);
});

test('clear-warnings confirmation opens without an unused Discord user lookup', async () => {
  let modal;
  let release;
  const pendingLookup = new Promise(resolve => { release = resolve; });
  const opening = warningClearAllHandler.execute({
    id: 'clear-warnings-safety', customId: 'warning_clear_all:target-user:moderator',
    user: { id: 'moderator' }, createdTimestamp: Date.now(),
    reply: async () => {},
    showModal: async shown => { modal = shown.toJSON(); },
  }, { users: { fetch: () => pendingLookup } });
  await new Promise(resolve => { setImmediate(resolve); });
  try {
    assert.equal(modal?.title, 'Clear All Warnings');
    assert.equal(modal.custom_id, 'warning_clear_confirm_modal:target-user:moderator');
  } finally {
    release(null);
    await opening;
  }
});

for (const color of ['1234', '12345']) {
  test(`hex color rejects invalid ${color.length}-digit codes before creating a NaN preview`, async () => {
    let reply;
    await hexColor.execute({
      id: `hexcolor-${color}`, user: { id: 'color-user' }, deferred: true,
      createdTimestamp: Date.now(), options: { getString: () => color },
      editReply: async payload => { reply = payload; },
    });
    const embed = reply.embeds[0].toJSON();
    assert.equal(embed.title, 'Invalid input');
    assert.match(embed.description, /Please provide a valid hex code/);
  });
}
