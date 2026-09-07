import fs from 'node:fs';

const pagePath = 'src/web/embedColorPickerPage.js';
let source = fs.readFileSync(pagePath, 'utf8');

const helperMarker = `      function renderRichEditor(editor, raw, className, onError) {`;
const helper = `      function cleanLegacyMobileSpacing(raw) {
        return String(raw || '')
          .split(String.fromCharCode(10))
          .map(line => {
            const normalized = line
              .replace(/\\u2060\\u2003\\u2009/g, ' ')
              .replace(/[\\u2063\\u2002\\u2009\\u200B\\u2800\\u00A0]/g, ' ');
            const leading = normalized.match(/^ +/)?.[0] || '';
            const rest = normalized.slice(leading.length).replace(/ {2,}/g, ' ');
            return leading + rest;
          })
          .join(String.fromCharCode(10));
      }

      function renderRichEditor(editor, raw, className, onError) {`;

if (!source.includes('function cleanLegacyMobileSpacing(raw)')) {
  if (!source.includes(helperMarker)) {
    console.error('[EMBED_BUILDER_MOBILE_SPACING] render marker not found');
    process.exit(1);
  }
  source = source.replace(helperMarker, helper);
}

source = source.replace(
  "          valueInput.value = field?.value || '';",
  "          valueInput.value = cleanLegacyMobileSpacing(field?.value || '');",
);
source = source.replace(
  "          messageInput.value = data.message || '';",
  "          messageInput.value = cleanLegacyMobileSpacing(data.message || '');",
);

// If cleanup changed already-stored text, immediately push only that cleaned
// text back through the existing live-preview save path. This removes spacing
// artifacts created by older mobile editor patches without touching titles,
// dots, fields names, colors, footer, logo, or media.
const stateMarker = `          lastValidTitle = titleInput.value;
          lastValidMessage = messageInput.value;
          renderTitleEditor(lastValidTitle);`;
const stateReplacement = `          lastValidTitle = titleInput.value;
          lastValidMessage = messageInput.value;
          const cleanedMessageChanged = messageInput.value !== String(data.message || '');
          renderTitleEditor(lastValidTitle);`;
if (!source.includes('const cleanedMessageChanged = messageInput.value')) {
  if (!source.includes(stateMarker)) {
    console.error('[EMBED_BUILDER_MOBILE_SPACING] state marker not found');
    process.exit(1);
  }
  source = source.replace(stateMarker, stateReplacement);
}

const readyMarker = `          updateCount(titleEditor); updateCount(messageEditor); updateCount(footerInput);
          setStatus(mode === 'footer' ? 'Footer editor ready.' : 'Emoji editor ready.');`;
const readyReplacement = `          updateCount(titleEditor); updateCount(messageEditor); updateCount(footerInput);
          if (cleanedMessageChanged) scheduleSave(messageInput);
          setStatus(mode === 'footer' ? 'Footer editor ready.' : 'Emoji editor ready.');`;
if (!source.includes('if (cleanedMessageChanged) scheduleSave(messageInput);')) {
  if (!source.includes(readyMarker)) {
    console.error('[EMBED_BUILDER_MOBILE_SPACING] ready marker not found');
    process.exit(1);
  }
  source = source.replace(readyMarker, readyReplacement);
}

fs.writeFileSync(pagePath, source, 'utf8');
console.log('[EMBED_BUILDER_MOBILE_SPACING] cleaned legacy spacing artifacts');
