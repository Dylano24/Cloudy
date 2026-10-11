import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { applyRuntimeEmbedTemplateData, primeSystemEmbedTemplateData } from '../src/services/systemEmbedCatalogService.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';

const logo = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const footer = '© Cloudy Inc. • Quality. Innovation. Performance.';

for (const title of ['Something went wrong', 'Permission denied']) {
  test(`${title} survives both outgoing template layers with logo and footer`, async t => {
    t.mock.method(db, 'get', async () => ({}));
    t.mock.method(db, 'set', async () => true);
    const guildId = `report-error-${title}`;
    const source = { guildId, channelId: 'reports', commandName: 'report' };
    const saved = { title: title === 'Permission denied' ? 'Permission Denied' : 'Ticket limit reached', description: 'saved', thumbnail: null, footer: null, schemaVersion: 3 };
    primeSystemEmbedTemplateData(title.toLowerCase(), 'report', saved, guildId);
    await saveEmbedTemplateDecoration(guildId, 'reports', [title], saved);
    const live = { title, description: 'The reported member is no longer in this server, so Timeout cannot be applied.', color: 0xED4245 };
    const runtime = applyRuntimeEmbedTemplateData(live, source);
    const result = await applySavedResponsePayloadTemplates({ embeds: [runtime] }, source);
    assert.equal(result.embeds[0].title, title);
    assert.equal(result.embeds[0].description, live.description);
    assert.equal(result.embeds[0].thumbnail?.url, logo);
    assert.equal(result.embeds[0].footer?.text, footer);
    assert.equal(runtime.title, title);
  });
}
