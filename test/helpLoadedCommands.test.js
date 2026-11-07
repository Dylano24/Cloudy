import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { createInitialHelpMenu } from '../src/commands/Core/help.js';
import { createAllCommandsMenu, helpCategorySelectMenu } from '../src/handlers/help/helpSelectMenus.js';

function fixture(admin = true) {
  const command = (name, category, options = [], extra = {}) => ({category,
    data: {name, description: 'Current ' + name, type: 1, options}, ...extra});
  let globalReads = 0;
  const client = {user: {username: 'Cloudy'}, commands: new Collection([
    ['game', command('game', 'Economy')], ['giveaway', command('giveaway', 'Giveaway', [{type: 1, name: 'create', description: 'Create a giveaway'}])],
    ['jointocreate', command('jointocreate', '00Overrides')], ['rank', command('rank', 'Leveling')],
    ['Cloudy report', command('Cloudy report', 'Utility', [], {data: {name: 'Cloudy report', type: 3}})],
  ]), application: {commands: {fetch: async () => {globalReads++; return new Collection();}}}};
  const interaction = {guildId: 'help-guild', user: {id: 'member'}, memberPermissions: {has: flag => admin && flag === PermissionFlagsBits.Administrator},
    guild: {commands: {fetch: async () => new Collection([['game', {name: 'game', id: 'guild-game-id'}], ['giveaway', {name: 'giveaway', id: 'guild-giveaway-id'}]])}}};
  return {client, interaction, globalReads: () => globalReads};
}

test('Help categories come from loaded commands rather than retired command files', async () => {
  const {client, interaction} = fixture();
  const menu = await createInitialHelpMenu(client, interaction);
  const options = menu.components.flatMap(row => row.toJSON().components.flatMap(item => item.options || []));
  assert.deepEqual(options.map(option => option.value).sort(), ['Economy', 'Giveaway', 'JoinToCreate', 'help-all-commands'].sort());
});

test('All Commands lists loaded slash routes once and uses guild registration IDs', async () => {
  const f = fixture();
  const menu = await createAllCommandsMenu(1, f.client, f.interaction);
  const text = JSON.stringify(menu.embeds.map(embed => embed.toJSON()));
  assert.match(text, /<\/game:guild-game-id>/);
  assert.match(text, /<\/giveaway create:guild-giveaway-id>/);
  assert.equal((text.match(/`\/jointocreate`/g) || []).length, 1);
  assert.doesNotMatch(text, /\/fish|\/flip|\/gdelete|\/rank|\/Cloudy report/);
  assert.equal(f.globalReads(), 0, 'a guild menu does not fetch global command registrations');
});

test('category selection cannot import an arbitrary directory and preserves member visibility', async () => {
  const f = fixture(false);
  let reply;
  const interaction = {...f.interaction, values: ['Giveaway'], deferUpdate: async () => {}, editReply: async payload => {reply = payload;}};
  await helpCategorySelectMenu.execute(interaction, f.client);
  assert.doesNotMatch(JSON.stringify(reply), /\/giveaway/);
});
