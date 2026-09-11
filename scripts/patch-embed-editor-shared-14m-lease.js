import fs from 'node:fs';

const marker = 'EMBED_EDITOR_SHARED_14M_LEASE_V1';
const pagePath = 'src/web/embedColorPickerPage.js';
const sessionPath = 'src/services/embedColorPickerSessionService.js';
const cleanupPath = 'src/utils/builderSessionCleanup.js';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_SHARED_14M] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(marker)) {
  const closeStart = page.indexOf('    function closeEditorSession() {');
  const closeEndMarker = "    window.addEventListener('beforeunload', closeEditorSession, { once: true });";
  const closeEnd = page.indexOf(closeEndMarker, closeStart);
  if (closeStart === -1 || closeEnd === -1) {
    console.error('[EMBED_EDITOR_SHARED_14M] editor unload lifecycle block not found');
    process.exit(1);
  }

  const afterClose = closeEnd + closeEndMarker.length;
  page = `${page.slice(0, closeStart)}    // ${marker}: browser unload/pagehide is not authoritative.\n    // The server-side shared inactivity lease owns editor + Builder lifetime.\n${page.slice(afterClose)}`;

  page = replaceRequired(
    page,
    "      if (!token || document.visibilityState !== 'visible' || heartbeatInFlight) return;",
    '      if (!token || heartbeatInFlight) return;',
    'heartbeat must survive hidden/mobile tabs when the browser allows it',
  );

  fs.writeFileSync(pagePath, page, 'utf8');
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = replaceRequired(
    session,
    "import {\n    releaseBuilderSessionHold,\n    runWithBuilderSessionHold,\n} from '../utils/builderSessionCleanup.js';",
    "import {\n    expireBuilderSessionHold,\n    releaseBuilderSessionHold,\n    runWithBuilderSessionHold,\n} from '../utils/builderSessionCleanup.js';",
    'expire hold import',
  );

  session = replaceRequired(
    session,
    'const SESSION_IDLE_MS = 14 * 60_000;',
    `export const EMBED_EDITOR_IDLE_MS = 14 * 60_000; // ${marker}`,
    'shared fourteen-minute constant',
  );

  session = replaceRequired(
    session,
    `function scheduleSessionIdleExpiry(token, session) {\n    clearSessionIdleTimer(session);\n    session.idleTimer = setTimeout(() => {\n        if (sessions.get(token) === session) deleteEmbedColorPickerSession(token);\n    }, SESSION_IDLE_MS);\n    session.idleTimer.unref?.();\n}`,
    `function scheduleSessionIdleExpiry(token, session) {\n    clearSessionIdleTimer(session);\n    session.idleTimer = setTimeout(() => {\n        if (sessions.get(token) === session) {\n            deleteEmbedColorPickerSession(token, { expireBuilder: true });\n        }\n    }, EMBED_EDITOR_IDLE_MS);\n    session.idleTimer.unref?.();\n}`,
    'shared expiry owns Builder deletion',
  );

  session = replaceRequired(
    session,
    `async function touchEditorSession(token, session) {\n    touchSession(token, session);\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    `async function touchEditorSession(token, session) {\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    'heartbeat must not reset inactivity by itself',
  );

  session = replaceRequired(
    session,
    `    touchSession(token, session);\n\n    if (value === CLOSE_PREFIX) {`,
    `    if (value === CLOSE_PREFIX) {`,
    'remove unconditional heartbeat reset',
  );

  session = replaceRequired(
    session,
    `    if (value === HEARTBEAT_PREFIX) {\n        const touched = await touchEditorSession(token, session);\n        if (!touched.ok) return touched;\n        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };\n    }\n\n    const held = await ensureEditorHold(token, session);`,
    `    if (value === HEARTBEAT_PREFIX) {\n        // The first heartbeat means the editor was entered/re-entered, so it\n        // starts a fresh fourteen-minute shared lease. Later heartbeats only\n        // keep the hold attached and do not fake user activity.\n        if (!session.holdActive) touchSession(token, session);\n        const touched = await touchEditorSession(token, session);\n        if (!touched.ok) return touched;\n        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };\n    }\n\n    // State loads, edits and color changes are real editor activity and each\n    // restarts the full fourteen-minute shared inactivity window.\n    touchSession(token, session);\n    const held = await ensureEditorHold(token, session);`,
    'real activity resets shared lease',
  );

  session = replaceRequired(
    session,
    `export function deleteEmbedColorPickerSession(token) {\n    const session = sessions.get(token);\n    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    clearSessionIdleTimer(session);\n    sessions.delete(token);\n    releaseBuilderSessionHold(token);\n}`,
    `export function deleteEmbedColorPickerSession(token, { expireBuilder = false } = {}) {\n    const session = sessions.get(token);\n    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    clearSessionIdleTimer(session);\n    sessions.delete(token);\n    if (expireBuilder) {\n        void expireBuilderSessionHold(token);\n    } else {\n        releaseBuilderSessionHold(token);\n    }\n}`,
    'shared lease expiry versus normal release',
  );

  fs.writeFileSync(sessionPath, session, 'utf8');
}

let cleanup = fs.readFileSync(cleanupPath, 'utf8');
if (!cleanup.includes(marker)) {
  cleanup = replaceRequired(
    cleanup,
    `export async function deleteBuilderSessionMessage(message) {\n  if (!message?.id) return false;\n\n  const key = String(message.id);\n  clearBuilderSessionTimer(key);`,
    `export async function deleteBuilderSessionMessage(message) {\n  if (!message?.id) return false;\n\n  const key = String(message.id);\n  // ${marker}: no cleanup path may delete the Builder while an editor lease\n  // owns it. expireBuilderSessionHold() removes the final hold first, so the\n  // legitimate fourteen-minute expiry still deletes normally.\n  if (isBuilderSessionHeld(key)) return false;\n  clearBuilderSessionTimer(key);`,
    'hard held-Builder delete guard',
  );

  fs.writeFileSync(cleanupPath, cleanup, 'utf8');
}

console.log('[EMBED_EDITOR_SHARED_14M] editor + canonical Builder now share one authoritative 14-minute inactivity lease');
console.log('[EMBED_EDITOR_SHARED_14M] entering/re-entering and real editor activity reset 14 minutes; normal Builder mode remains 5 minutes');
