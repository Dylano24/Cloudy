import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType } from 'discord.js';
import {
  amsterdamClock, disableRustRestartSchedule, getRustRestartConfig,
  parseRustRestartTimes, processRustRestartNotices, publishRustRestartSchedule,
  restartEventsAt, scheduleEmbed,
} from '../src/services/rustRestartScheduleService.js';

function setup() {
  const storage = new Map();
  const sends = [];
  const channel = {
    id: '1532882647838228821', type: ChannelType.GuildText,
    send: async payload => {
      sends.push(payload);
      return { id: '1532882647838228822', channelId: channel.id, edit: async () => {} };
    },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => null },
  };
  const guild = {
    id: '1532882647838228820',
    channels: { fetch: async id => id === channel.id ? channel : null },
  };
  const client = {
    db: {
      get: async key => storage.get(key) || null,
      set: async (key, value) => { storage.set(key, structuredClone(value)); return true; },
    },
    guilds: { cache: new Map([[guild.id, guild]]) },
    user: { id: '1532882647838228830' },
  };
  return { storage, sends, channel, guild, client };
}

test('Restart times must use valid HH:mm with no duplicates', () => {
  assert.deepEqual(parseRustRestartTimes('18:00, 06:00'), ['06:00', '18:00']);
  assert.throws(() => parseRustRestartTimes('6:00'), /24-hour format/);
  assert.throws(() => parseRustRestartTimes('24:00'), /24-hour format/);
  assert.throws(() => parseRustRestartTimes('06:00,06:00'), /duplicate/);
  assert.throws(() => parseRustRestartTimes('06:00, Monday'), /24-hour format/);
});

test('Reminder uses Amsterdam time and keeps the exact day across DST', () => {
  assert.deepEqual(amsterdamClock(Date.parse('2026-11-09T04:45:00Z')), {
    date: '2026-11-09', time: '05:45', minute: 345,
  });
  const config = { enabled: true, times: ['06:00'], reminderMinutes: 15 };
  assert.deepEqual(restartEventsAt(config, Date.parse('2026-11-09T04:45:00Z')),
    [{ kind: 'reminder', at: '06:00', date: '2026-11-09' }]);
  assert.deepEqual(restartEventsAt(config, Date.parse('2026-11-09T05:00:00Z')),
    [{ kind: 'time', at: '06:00', date: '2026-11-09' }]);
  assert.deepEqual(restartEventsAt({ ...config, enabled: false }, Date.parse('2026-11-09T05:00:00Z')), []);
});

test('Restart schedule has Cloudy logo and plain footer', () => {
  const embed = scheduleEmbed({ times: ['06:00', '18:00'], reminderMinutes: 15 });
  assert.equal(embed.title, 'Daily server restarts');
  assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  assert.match(embed.footer.text, /Cloudy Inc/);
  assert.match(embed.description, /notifications, not automatic/);
});

test('Restart announcements persist deduplication across ticks', async () => {
  const { client, channel, guild, sends } = setup();
  await publishRustRestartSchedule(client, guild, channel, '06:00', 15);
  assert.equal(sends.length, 1);
  await processRustRestartNotices(client, Date.parse('2026-11-09T04:45:00Z'));
  await processRustRestartNotices(client, Date.parse('2026-11-09T04:45:30Z'));
  assert.equal(sends.length, 2);
  assert.equal(sends[1].embeds[0].title, 'Restart reminder');
  await processRustRestartNotices(client, Date.parse('2026-11-09T05:00:00Z'));
  await processRustRestartNotices(client, Date.parse('2026-11-09T05:00:30Z'));
  assert.equal(sends.length, 3);
  assert.equal(sends[2].embeds[0].title, 'Scheduled restart time');
  assert.equal((await getRustRestartConfig(client, guild.id)).sent['time:06:00'], '2026-11-09');
  await disableRustRestartSchedule(client, guild.id);
  await processRustRestartNotices(client, Date.parse('2026-11-10T05:00:00Z'));
  assert.equal(sends.length, 3);
});
