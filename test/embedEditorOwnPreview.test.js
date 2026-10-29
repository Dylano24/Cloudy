import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { embedColorPickerPage } from '../src/web/embedColorPickerPage.js';

const builderSource = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

test('the editor page shows its own live preview from the exact Builder preview', () => {
  const html = embedColorPickerPage();
  assert.match(html, /id="previewSection"/);
  assert.match(html, /id="embedPreview" class="dc-embed"/);
  assert.match(html, /CLOUDY_EDITOR_OWN_PREVIEW_V1/);
  // Loaded with the editor state, refreshed by every heartbeat, and in the colour picker.
  assert.match(html, /applyServerPreview\(data\)/);
  assert.match(html, /applyServerPreview\(heartbeat\)/);
  assert.match(html, /__CLOUDY_EMBED_PREVIEW__/);
  // Typing and colour changes show at once.
  assert.match(html, /setPreviewOverride\(field, value\)/);
  assert.match(html, /previewOverrides\.color = parseInt/);
  // An uploaded banner comes from the session's media route.
  assert.match(html, /apiUrl \+ '\/media\?v='/);
  // After Discord's 15 minutes the page says what to do.
  assert.match(html, /Press Save or Post in the Builder in Discord/);
});

test('the page script has no characters that the server template would change', () => {
  const html = embedColorPickerPage();
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
  const start = script.indexOf('CLOUDY_EDITOR_OWN_PREVIEW_V1');
  const block = script.slice(start, script.indexOf("if (mode === 'content' || mode === 'footer')", start));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /[`]/);
});

test('a paused Discord preview no longer ends the editor; only an ended Builder does', () => {
  const mark = builderSource.slice(builderSource.indexOf('function markBuilderPreviewUnavailable'),
    builderSource.indexOf('// BUILDER_SINGLE_PREVIEW_TARGET_V1'));
  assert.match(mark, /state\.builderPreviewUnavailable = true/);
  assert.doesNotMatch(mark, /deleteEmbedColorPickerSession/);
  const hold = builderSource.slice(builderSource.indexOf('onEditorHold: async () => {'), builderSource.indexOf('onEditorUpdate: async'));
  assert.match(hold, /if \(!state\.builderDashboardMessage\)/);
  assert.doesNotMatch(hold, /builderPreviewUnavailable \|\|/);
  // The editor still ends together with the Builder.
  assert.match(builderSource, /collector\.on\('end'[\s\S]*deleteEmbedColorPickerSession\(colorSessionToken\)/);
  assert.match(builderSource, /getPreviewEmbed: \(\) => buildPreviewEmbed\(state\)\.toJSON\(\)/);
});

test('the media route only serves images of a live editor session', () => {
  const app = fs.readFileSync('src/app.js', 'utf8');
  assert.match(app, /app\.get\('\/api\/embed-color\/:token\/media'/);
  assert.match(app, /getEmbedEditorMedia\(req\.params\.token\)/);
  assert.match(app, /if \(!media \|\| !type\) return res\.status\(404\)\.end\(\)/);
  assert.match(app, /X-Content-Type-Options', 'nosniff'/);
});
