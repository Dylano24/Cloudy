import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pageTarget = path.resolve(__dirname, '../src/web/embedColorPickerPage.js');
const builderTarget = path.resolve(__dirname, '../src/commands/Tools/embedbuilder.js');
const sessionTarget = path.resolve(__dirname, '../src/services/embedColorPickerSessionService.js');

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

let pageSource = fs.readFileSync(pageTarget, 'utf8');
if (!pageSource.includes(replacement)) {
  if (!pageSource.includes(oldLine)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected heartbeat lifecycle marker not found');
    process.exit(1);
  }
  pageSource = pageSource.replace(oldLine, replacement);
  fs.writeFileSync(pageTarget, pageSource, 'utf8');
}

const oldCollectorEnd = `            collector.on('end', async () => {
                if (state.activeEmbedManager) {
                    state.activeEmbedManager.closed = true;
                    state.activeEmbedManager.collector?.stop('builder-ended');
                    state.activeEmbedManager = null;
                }
                deleteEmbedColorPickerSession(colorSessionToken);
            });`;

const newCollectorEnd = `            collector.on('end', async (_collected, reason) => {
                if (state.activeEmbedManager) {
                    state.activeEmbedManager.closed = true;
                    state.activeEmbedManager.collector?.stop('builder-ended');
                    state.activeEmbedManager = null;
                }

                // The browser editor/picker owns its session lifetime. A collector
                // ending for cleanup/replacement must not silently kill a still-open
                // web editor. Only an intentional Post completes the builder here.
                if (reason === 'posted') {
                    deleteEmbedColorPickerSession(colorSessionToken);
                }
            });`;

let builderSource = fs.readFileSync(builderTarget, 'utf8');
if (!builderSource.includes(newCollectorEnd)) {
  if (!builderSource.includes(oldCollectorEnd)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected builder collector lifecycle marker not found');
    process.exit(1);
  }
  builderSource = builderSource.replace(oldCollectorEnd, newCollectorEnd);
  fs.writeFileSync(builderTarget, builderSource, 'utf8');
}

const oldEditorSaveAck = `        const nextValue = payload.value.slice(0, limit);
        queueEditorUpdate(token, session, field, nextValue);
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`;

const newEditorSaveAck = `        const nextValue = payload.value.slice(0, limit);
        try {
            await session.onEditorUpdate(field, nextValue);
        } catch (error) {
            if (error?.code !== 'EMBED_BUILDER_EXPIRED') throw error;
        }
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`;

let sessionSource = fs.readFileSync(sessionTarget, 'utf8');
if (!sessionSource.includes(newEditorSaveAck)) {
  if (!sessionSource.includes(oldEditorSaveAck)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected editor save acknowledgement marker not found');
    process.exit(1);
  }
  sessionSource = sessionSource.replace(oldEditorSaveAck, newEditorSaveAck);
  fs.writeFileSync(sessionTarget, sessionSource, 'utf8');
}

console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] patched persistent editor hold + explicit completion cleanup + synchronous editor save');
