import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('each live bot embed applies a single authoritative snapshot of saved templates', () => {
  const source = fs.readFileSync('src/services/embedTemplateService.js', 'utf8');
  const start = source.indexOf('export async function applySavedEmbedTemplates(');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\n}', start));
  const loadCalls = body.match(/loadMergedTemplates\(message\.guildId, message\.channelId, \{ preferGlobal: true \}\)/g) || [];

  assert.equal(loadCalls.length, 1,
    'the same global+channel merged template is currently loaded twice for every embed; one load must serve all message embeds');
  assert.match(body, /preserveRuntimeBody:\s*sharedRuntimeBody/,
    'dynamic Success, Error and gambling messages must keep their live variable text');
  assert.match(body, /PRESERVE_EXISTING_EMBEDS/,
    'unmodified existing embeds must keep their existing behavior');
});
