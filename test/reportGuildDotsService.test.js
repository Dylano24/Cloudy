import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { ensureReportGuildDots } from '../src/services/reportGuildDotsService.js';

test('Dylano report status dots are uploaded as guild emoji exactly once', async () => {
  const existing = new Collection([
    ['w', { id: 'w', name: 'W87205667glowingdotwhite' }],
    ['g', { id: 'g', name: 'glowing_dot_green' }],
    ['r', { id: 'r', name: 'W8733476glowingdotred' }],
  ]);
  const uploaded = [];
  const guild = {
    emojis: {
      fetch: async () => existing,
      create: async ({ name, attachment, reason }) => {
        assert.ok(Buffer.isBuffer(attachment), 'emoji upload must use a real image buffer');
        assert.ok(attachment.length > 0);
        assert.equal(reason, 'Cloudy Inc. report status dots');
        const result = { id: String(2000 + uploaded.length), name };
        uploaded.push(result);
        existing.set(result.id, result);
        return result;
      },
    },
  };
  const client = {
    guilds: {
      cache: new Collection([['1532882647838228723', guild]]),
      fetch: async () => assert.fail('the guild already exists in cache'),
    },
  };

  await ensureReportGuildDots(client);
  assert.deepEqual(uploaded.map(emoji => emoji.name), [
    'cloudy_report_dot_blue',
    'cloudy_report_dot_orange',
  ]);

  await ensureReportGuildDots(client);
  assert.equal(uploaded.length, 2, 'restart must not create duplicate guild emoji');
});

test('missing Dylano server does not interrupt bot ready', async () => {
  const client = {
    guilds: {
      cache: new Collection(),
      fetch: async () => null,
    },
  };
  await assert.doesNotReject(ensureReportGuildDots(client));
});
