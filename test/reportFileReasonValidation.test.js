import test from 'node:test';
import assert from 'node:assert/strict';
import report from '../src/commands/Utility/modules/report.js';

// /report file follows the same rule as the "Cloudy report" form: a real
// reason of at least three characters. An invalid reason never reserves a
// report number and never reaches the staff channel.

function interactionWith(reason) {
  const shown = [];
  const touched = [];
  const database = new Proxy({}, { get: (_target, name) => (...args) => { touched.push([String(name), ...args]); return null; } });
  const interaction = {
    id: 'report-file', guildId: '100000000000000001', channelId: '100000000000000002', commandName: 'report',
    createdTimestamp: Date.now(), deferred: false, replied: false,
    user: { id: '100000000000000003', tag: 'reporter' },
    guild: { id: '100000000000000001', ownerId: '100000000000000009', channels: { fetch: async () => null } },
    channel: { toString: () => '<#100000000000000002>' },
    inGuild: () => true, isRepliable: () => true,
    options: {
      getUser: () => ({ id: '100000000000000004', tag: 'target', displayAvatarURL: () => null }),
      getString: name => (name === 'reason' ? reason : null),
      getAttachment: () => null,
      getSubcommand: () => 'file',
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async payload => { shown.push(payload); interaction.replied = true; return { id: 'reply' }; },
    reply: async payload => { shown.push(payload); interaction.replied = true; return { id: 'reply' }; },
    followUp: async payload => { shown.push(payload); return { id: 'reply' }; },
    deleteReply: async () => {},
  };
  return { interaction, shown, touched, client: { db: database, user: { id: 'bot' }, guilds: { cache: new Map() } } };
}

for (const reason of ['', '  ', 'a', ' ab ', '\n\n']) {
  test(`/report file refuses the reason ${JSON.stringify(reason)} before anything is numbered or sent`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = interactionWith(reason);
    await report.execute(f.interaction, {}, f.client);
    assert.match(JSON.stringify(f.shown), /Please provide a valid report reason of at least three characters\./);
    assert.deepEqual(f.touched, [], 'no report number was reserved and nothing was stored');
  });
}
