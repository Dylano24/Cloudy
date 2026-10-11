import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { saveExistingEmbed } from '../src/commands/Tools/embedbuilder.js';

test('failed persistence after a Discord edit reports partial success accurately', async t => {
  const guildId = 'builder-partial-save';
  const message = { id: 'message', guildId, channelId: 'channel', author: { id: 'bot' }, flags: { has: () => false },
    embeds: [new Embed({ title: 'Before', description: 'Body' })] };
  message.edit = async payload => { message.embeds = payload.embeds.map(data => new Embed(data)); return message; };
  const channel = { id: 'channel', guild: { id: guildId }, messages: { cache: new Collection([['message', message]]), fetch: async () => message } };
  message.channel = channel;
  const guild = { id: guildId, client: { user: { id: 'bot' } }, channels: { cache: new Collection([['channel', channel]]) } };
  t.mock.method(db, 'get', async () => []);
  t.mock.method(db, 'set', async () => false);
  const state = { title: 'After', message: 'Edited', embedFields: [], sideColor: 0xffffff, showLogo: false,
    modifyTarget: { channelId: 'channel', messageId: 'message', embedIndex: 0, sourceEmbedData: message.embeds[0].toJSON(), templateMode: false } };
  const result = await saveModifiedEmbed(guild, state);
  assert.equal(result.ok, false);
  assert.equal(message.embeds[0].title, 'After');
  assert.equal(result.discordUpdated, true);
  const replies = [];
  await saveExistingEmbed({ deferUpdate: async () => {}, followUp: async payload => { replies.push(payload); return null; } }, guild, state);
  assert.equal(replies[0].embeds[0].toJSON().description, 'The Discord message was updated, but the changes could not be saved permanently. Please try Save again.');
});
