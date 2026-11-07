import test from 'node:test';
import assert from 'node:assert/strict';
import {Collection} from 'discord.js';
import {ensureSupportBotEmoji} from '../src/services/supportBotEmojiService.js';

test('parallel support emoji preparation uploads only one white icon and reuses it afterwards', async () => {
  const cache = new Collection();
  const uploads = [];
  const client = {application: {emojis: {cache,
    fetch: async () => cache,
    create: async payload => {uploads.push(payload); return {id: '1800000000000000099', name: payload.name, animated: false};}}}};
  const results = await Promise.all([ensureSupportBotEmoji(client), ensureSupportBotEmoji(client)]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].name, 'cloudy_support_bot_white');
  assert.equal(uploads[0].attachment.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(results[0], {id: '1800000000000000099', name: 'cloudy_support_bot_white', animated: false});
  await ensureSupportBotEmoji(client);
  assert.equal(uploads.length, 1);
});
