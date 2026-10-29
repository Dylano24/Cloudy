import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { formatStartTime, parseStartTime } from '../src/services/cloudyFeedStartTime.js';
import { applyAction } from '../src/services/cloudyFeedService.js';

// 29 October 2026, 13:00 in the Netherlands (winter time, UTC+1).
const NOW = Date.UTC(2026, 9, 29, 12, 0);

test('Start time is read as Netherlands time, today or the next day', () => {
  assert.equal(parseStartTime('', NOW), null);
  assert.equal(parseStartTime('   ', NOW), null);
  assert.equal(parseStartTime('20:00', NOW), Date.UTC(2026, 9, 29, 19, 0));
  assert.equal(parseStartTime('9.30', NOW), Date.UTC(2026, 9, 30, 8, 30), 'already passed today: tomorrow');
  assert.equal(parseStartTime('13:00', NOW), Date.UTC(2026, 9, 30, 12, 0), 'exactly now: tomorrow');
});

test('Start time accepts a date, with summer and winter time', () => {
  assert.equal(parseStartTime('30-10 20:00', NOW), Date.UTC(2026, 9, 30, 19, 0));
  assert.equal(parseStartTime('30/10/2026 20:00', NOW), Date.UTC(2026, 9, 30, 19, 0));
  // 1 July is summer time (UTC+2) and already passed this year.
  assert.equal(parseStartTime('1-7 20:00', NOW), Date.UTC(2027, 6, 1, 18, 0));
  assert.equal(parseStartTime('01-07-2027 08:05', NOW), Date.UTC(2027, 6, 1, 6, 5));
});

test('Start time rejects wrong, past and far-away times with a clear message', () => {
  for (const value of ['20', '8pm', '25:00', '20:60', '31-02 20:00', '30-13 20:00', 'tomorrow', '2026-10-30 20:00']) {
    assert.throws(() => parseStartTime(value, NOW), /Start time must look like 20:00 or 30-10 20:00\./, value);
  }
  assert.throws(() => parseStartTime('28-10-2026 20:00', NOW), /must be in the future/);
  assert.throws(() => parseStartTime('01-01-2028 10:00', NOW), /within one year/);
});

test('Edit feed shows the saved Start time in a format the form accepts again', () => {
  const sameYear = Date.UTC(2026, 9, 30, 19, 0);
  const nextYear = Date.UTC(2027, 6, 1, 18, 0);
  assert.equal(formatStartTime(sameYear, NOW), '30-10 20:00');
  assert.equal(formatStartTime(nextYear, NOW), '01-07-2027 20:00');
  assert.equal(formatStartTime(undefined, NOW), '');
  for (const value of [sameYear, nextYear]) {
    assert.equal(parseStartTime(formatStartTime(value, NOW), NOW), value);
  }
});

function feedHarness(feed) {
  let stored = [structuredClone(feed)];
  const channel = {
    id: feed.channelId, name: 'feed', type: ChannelType.GuildText, nsfw: true,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: '1532882647838228723',
    members: { me: {} },
    channels: { fetch: async id => id === channel.id ? channel : null },
  };
  const client = {
    db: {
      get: async () => structuredClone(stored),
      set: async (_key, value) => { stored = structuredClone(value); },
      getStatus: () => ({ isDegraded: false }),
    },
  };
  return { guild, interaction: { client, isModalSubmit: () => false }, stored: () => stored };
}

const FEED = {
  id: '04db1b8f', name: 'Video feed', source: 'https://example.org/gallery',
  channelId: '1532882647838228724', channelName: 'feed', minutes: 60, adult: true,
  active: true, mediaType: 'video', recentUrls: [], nextAt: Date.now() + 60 * 60_000,
};

test('a Start time makes the first post wait for it; clearing it starts as before', async () => {
  const { guild, interaction } = feedHarness(FEED);
  const before = Date.now();
  const [saved] = await applyAction(interaction, guild, 'edit', { feedId: FEED.id, start: '23:59' });
  assert.ok(saved.startAt > before);
  assert.equal(saved.nextAt, saved.startAt);

  const [unchanged] = await applyAction(interaction, guild, 'edit', {
    feedId: FEED.id, start: formatStartTime(saved.startAt),
  });
  assert.equal(unchanged.startAt, saved.startAt, 'an unchanged form keeps the saved Start time');
  assert.equal(unchanged.nextAt, saved.startAt);

  const [timerOnly] = await applyAction(interaction, guild, 'edit', { feedId: FEED.id, minutes: '30' });
  assert.equal(timerOnly.startAt, saved.startAt, 'a change without the Start time field keeps it');

  const [paused] = await applyAction(interaction, guild, 'pause', { feedId: FEED.id });
  const [resumed] = await applyAction(interaction, guild, 'pause', { feedId: FEED.id });
  assert.equal(paused.active, false);
  assert.equal(resumed.active, true);
  assert.equal(resumed.nextAt, saved.startAt, 'resuming before the Start time still waits for it');

  const cleared = Date.now();
  const [none] = await applyAction(interaction, guild, 'edit', { feedId: FEED.id, start: '' });
  assert.equal(none.startAt, null);
  assert.ok(none.nextAt >= cleared + 30 * 60_000 && none.nextAt <= Date.now() + 30 * 60_000);
});

test('an invalid Start time leaves the feed unchanged', async () => {
  const { guild, interaction, stored } = feedHarness(FEED);
  await assert.rejects(applyAction(interaction, guild, 'edit', { feedId: FEED.id, start: 'later' }),
    /Start time must look like/);
  assert.equal(stored()[0].nextAt, FEED.nextAt);
  assert.equal(Object.hasOwn(stored()[0], 'startAt'), false);
});
