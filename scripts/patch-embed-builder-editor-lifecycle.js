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
    // IMPORTANT: visibilitychange/pagehide are NOT close signals. Mobile and
    // desktop browsers can fire/suspend those while the editor is still open
    // in another tab/app. Only an actual document unload/leave may release the
    // Discord builder hold and restart its five-minute inactivity timer.
    window.addEventListener('beforeunload', closeEditorSession, { once: true });`;

if (original.includes(replacement)) {
  console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] already current');
  process.exit(0);
}

if (!original.includes(oldLine)) {
  console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected heartbeat lifecycle marker not found');
  process.exit(1);
}

fs.writeFileSync(target, original.replace(oldLine, replacement), 'utf8');
console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] patched background-safe editor hold + explicit unload release');
