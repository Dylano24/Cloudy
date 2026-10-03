import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';

function fixture(extra = {}) {
  const edits = [];
  const message = {
    id: 'beg-result', guildId: 'command-save-guild', channelId: 'gambling',
    author: { id: 'bot' }, flags: { has: () => false },
    embeds: [new Embed({ title: 'Insufficient Funds', description: 'You gave up.' })],
    ...extra,
  };
  message.edit = async payload => {
    edits.push(payload);
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const channel = {
    id: message.channelId, guild: { id: message.guildId },
    messages: { cache: new Collection([[message.id, message]]), fetch: async () => message },
  };
  message.channel = channel;
  const guild = {
    id: message.guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const state = {
    title: 'Insufficient funds', message: 'Edited beg response', embedFields: [],
    sideColor: 0xFFFFFF, showLogo: false,
    modifyTarget: {
      channelId: channel.id, messageId: message.id, embedIndex: 0,
      sourceEmbedData: message.embeds[0].toJSON(), templateMode: false,
    },
  };
  return { message, channel, guild, state, edits };
}

test('Save edits public slash command results with modern and legacy metadata, including repeated saves', async () => {
  for (const metadata of [{ interactionMetadata: { id: 'command' } }, { interaction: { id: 'command' } }]) {
    const { guild, state, edits } = fixture(metadata);
    assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
    state.message = 'Second edit';
    assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
    assert.equal(edits.length, 2);
    assert.equal(edits[1].embeds[0].description, 'Second edit');
  }
});

test('Save still refuses private results and the real-looking preview within a Builder panel', async () => {
  for (const extra of [
    { flags: { has: flag => flag === MessageFlags.Ephemeral } },
    { embeds: [new Embed({ title: 'Insufficient funds' }), new Embed({ title: 'Message builder' })] },
    { embeds: [new Embed({ title: 'Modify embed' })] },
    { author: { id: 'other-bot' } },
  ]) {
    const { guild, state, edits } = fixture(extra);
    assert.equal((await saveModifiedEmbed(guild, state)).ok, false);
    assert.equal(edits.length, 0);
  }
});

test('discovery includes public command results but excludes whole Builder preview panels', async () => {
  const { message, channel, guild } = fixture({ interactionMetadata: { id: 'command' } });
  const panel = {
    ...message, id: 'builder-panel',
    embeds: [new Embed({ title: 'Insufficient funds' }), new Embed({ title: 'Message builder' })],
  };
  const messages = new Collection([[panel.id, panel], [message.id, message]]);
  channel.messages.cache = messages;
  channel.messages.fetch = async () => messages;
  const records = await discoverRecentChannelEmbeds(guild, channel.id, 'bot');
  assert.deepEqual(records.map(record => record.messageId), [message.id]);
});
