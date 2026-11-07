import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';

const values = new Map();
db.initialized = true;
db.useFallback = false;
db.db = { get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); return true; } };
const guildId = 'system-error-guild';
const channelId = 'system-error-channel';

test('a template saved from the ticket-limit reply never renames the generic "Something went wrong" error', async () => {
  // A Builder Save of the ticket-limit reply, made while it was titled "Something went wrong".
  assert.equal(await saveEmbedTemplateDecoration(guildId, channelId, ['Something went wrong'], { title: 'Ticket limit reached', color: 0xED4245 }), true);
  const output = await applySavedResponsePayloadTemplates({
    embeds: [{ title: 'Something went wrong', description: 'The reported message no longer exists, so Delete was not applied.', color: 0xED4245 }],
  }, { guildId, channelId });
  assert.equal(output.embeds[0].title, 'Something went wrong');
  assert.equal(output.embeds[0].description, 'The reported message no longer exists, so Delete was not applied.');
});
