import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const target = path.resolve(__dirname, '../src/web/embedColorPickerPage.js');

const original = fs.readFileSync(target, 'utf8');
const oldLine = "    window.addEventListener('pagehide', () => clearInterval(heartbeatTimer), { once: true });";
const replacement = `    function closeEditorSession() {
      clearInterval(heartbeatTimer);
      if (!token) return;
      const payload = JSON.stringify({ color: '__CLOUDY_EMBED_CLOSE__' });
      try {
        if (typeof navigator.sendBeacon === 'function') {
          const blob = new Blob([payload], { type: 'application/json' });
          if (navigator.sendBeacon(apiUrl, blob)) return;
        }
      } catch {}
      try {
        void fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }
    window.addEventListener('pagehide', event => {
      // Switching apps/tabs on mobile only makes the page hidden and MUST NOT
      // release the Discord builder. A real page leave/close starts the normal
      // five-minute Discord inactivity period again.
      if (!event.persisted) closeEditorSession();
    }, { once: true });`;

if (original.includes(replacement)) {
  console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] already current');
  process.exit(0);
}

if (!original.includes(oldLine)) {
  console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected heartbeat lifecycle marker not found');
  process.exit(1);
}

fs.writeFileSync(target, original.replace(oldLine, replacement), 'utf8');
console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] patched persistent editor hold + close release');
