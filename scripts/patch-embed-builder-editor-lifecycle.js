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
}

pageSource = pageSource
  .replace('white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }', 'white-space: break-spaces; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }')
  .replace('white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }', 'white-space: break-spaces; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }');

const indentHelperMarker = `      function bindFieldEditor(editor, input, options) {`;
const indentHelper = `      function preserveManualIndentSpaces(editor, syncFn, rememberFn) {
        editor.addEventListener('beforeinput', event => {
          if (event.inputType !== 'insertText' || event.data !== ' ') return;
          const selection = window.getSelection();
          const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
          if (!range || !selectionIsInside(range, editor)) return;

          const beforeRange = range.cloneRange();
          beforeRange.selectNodeContents(editor);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const before = beforeRange.toString();
          const lineStart = before.lastIndexOf(String.fromCharCode(10)) + 1;
          const currentLinePrefix = before.slice(lineStart);

          // Only special-case indentation at the start of a logical line.
          // Each tap inserts exactly one preserved space-width token so iOS
          // shows movement immediately. Mid-sentence spaces stay completely
          // normal, preventing large gaps such as "while     the".
          if (currentLinePrefix && !/^[\u2063\u2009 ]+$/.test(currentLinePrefix)) return;

          event.preventDefault();
          range.deleteContents();
          const node = document.createTextNode(String.fromCharCode(8291) + String.fromCharCode(8201));
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          syncFn();
          rememberFn?.();
        });
      }

      function bindFieldEditor(editor, input, options) {`;
if (!pageSource.includes('function preserveManualIndentSpaces(editor, syncFn, rememberFn)')) {
  if (!pageSource.includes(indentHelperMarker)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected field editor marker not found');
    process.exit(1);
  }
  pageSource = pageSource.replace(indentHelperMarker, indentHelper);
}

// Upgrade the previous mobile-spacing implementation in already-patched source.
pageSource = pageSource.replace(
`          const beforeRange = range.cloneRange();
          beforeRange.selectNodeContents(editor);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const before = beforeRange.toString();
          const atLineStart = !before || before.endsWith(String.fromCharCode(10));
          if (!atLineStart) return;

          // iOS/Safari can drop a normal leading space in contenteditable.
          // Anchor only the first leading space with a zero-width character,
          // then keep every following space as a normal BREAKABLE space.
          // This avoids the large gaps/non-wrapping caused by NBSP on mobile.
          event.preventDefault();
          range.deleteContents();
          const node = document.createTextNode(String.fromCharCode(8203) + ' ');`,
`          const beforeRange = range.cloneRange();
          beforeRange.selectNodeContents(editor);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const before = beforeRange.toString();
          const lineStart = before.lastIndexOf(String.fromCharCode(10)) + 1;
          const currentLinePrefix = before.slice(lineStart);

          // Only special-case indentation at the start of a logical line.
          // Each tap inserts exactly one preserved space-width token so iOS
          // shows movement immediately. Mid-sentence spaces stay completely
          // normal, preventing large gaps such as "while     the".
          if (currentLinePrefix && !/^[\\u2063\\u2009 ]+$/.test(currentLinePrefix)) return;

          event.preventDefault();
          range.deleteContents();
          const node = document.createTextNode(String.fromCharCode(8291) + String.fromCharCode(8201));`
);

const fieldBindMarker = `        editor.addEventListener('paste', event => {`;
const fieldBindReplacement = `        if (state.allowNewlines) {
          preserveManualIndentSpaces(editor, () => syncFieldFromEditor(editor), () => rememberFieldRange(editor));
        }
        editor.addEventListener('paste', event => {`;
if (!pageSource.includes('preserveManualIndentSpaces(editor, () => syncFieldFromEditor(editor)')) {
  if (!pageSource.includes(fieldBindMarker)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected field paste marker not found');
    process.exit(1);
  }
  pageSource = pageSource.replace(fieldBindMarker, fieldBindReplacement);
}

const messageBindMarker = `      messageEditor.addEventListener('paste', event => {`;
const messageBindReplacement = `      preserveManualIndentSpaces(messageEditor, () => syncMessageFromEditor(), () => rememberRange(messageEditor, 'message'));
      messageEditor.addEventListener('paste', event => {`;
if (!pageSource.includes("preserveManualIndentSpaces(messageEditor, () => syncMessageFromEditor()")) {
  if (!pageSource.includes(messageBindMarker)) {
    console.error('[EMBED_BUILDER_EDITOR_LIFECYCLE] expected message paste marker not found');
    process.exit(1);
  }
  pageSource = pageSource.replace(messageBindMarker, messageBindReplacement);
}

fs.writeFileSync(pageTarget, pageSource, 'utf8');

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

console.log('[EMBED_BUILDER_EDITOR_LIFECYCLE] patched persistent editor hold + explicit completion cleanup + synchronous editor save + one-tap mobile indentation');
