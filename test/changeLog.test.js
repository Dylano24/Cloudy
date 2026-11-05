import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import changelog from '../src/commands/GameServer/changelog.js';
import changelogForm from '../src/interactions/modals/changelog.js';
import { buildChangeLog } from '../src/services/changeLogService.js';

test('/changelog opens a staff form with server, changes and note', async () => {
  const data = changelog.data.toJSON();
  assert.equal(data.name, 'changelog');
  let modal;
  await changelog.execute({ showModal: async value => { modal = value.toJSON(); } });
  assert.equal(modal.custom_id, 'changelog_form');
  assert.deepEqual(modal.components.map(row => row.components[0].custom_id), ['server', 'changes', 'note']);
});

test('a change log lists every change as a bullet, with the staff member, time, logo and footer', () => {
  const embed = buildChangeLog({ server: 'Server 1 Rust', changes: '- Gather rate 2x\n\n• Decay off\nUpkeep @everyone', note: 'Back to normal next wipe', userId: '42', time: 1_800_000_000_000 }).embeds[0];
  assert.equal(embed.title, 'Server changes');
  assert.equal(embed.description, [
    '**Server:** Server 1 Rust', '', '• Gather rate 2x', '• Decay off', '• Upkeep @​everyone', '',
    'Back to normal next wipe', '', '**Changed by:** <@42>', '**Time:** <t:1800000000:f>',
  ].join('\n'));
  assert.ok(embed.thumbnail.url);
  assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
});

test('the form posts in #change-logs and answers with a 10-second notice', async () => {
  const sent = [];
  const channel = { id: '240000000000000000', name: '🚧│change-logs', type: ChannelType.GuildText, isTextBased: () => true, send: async payload => { sent.push(payload); } };
  const interaction = {
    guild: { channels: { cache: new Collection([[channel.id, channel]]) } }, user: { id: '42' },
    fields: { getTextInputValue: name => ({ server: 'Server 1 Rust', changes: 'Decay off', note: '' })[name] },
    deferReply: async () => {}, editReply: async payload => { interaction.reply = payload; }, deleteReply: async () => {},
  };
  await changelogForm.execute(interaction);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].title, 'Server changes');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.match(JSON.stringify(interaction.reply.embeds[0].toJSON?.() || interaction.reply.embeds[0]), /change-logs|<#240000000000000000>/);
});
