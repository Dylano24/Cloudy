import fs from 'node:fs';

const servicePath = 'src/services/embedColorPickerSessionService.js';
const pagePath = 'src/web/embedColorPickerPage.js';
const marker = 'EDITOR_OPEN_LEASE_V1';
const pageMarker = 'EDITOR_OPEN_HEARTBEAT_V1';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_OPEN_LEASE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let service = fs.readFileSync(servicePath, 'utf8');
if (!service.includes(marker)) {
  service = replaceRequired(
    service,
    'export const EMBED_EDITOR_IDLE_MS = 14 * 60_000;',
    `export const EMBED_EDITOR_IDLE_MS = 14 * 60_000;\nexport const EMBED_EDITOR_CLOSE_GRACE_MS = 3_000; // ${marker}: ignore unload/reload races before releasing the builder hold`,
    'editor lease constants',
  );

  service = replaceRequired(
    service,
    `function clearSessionIdleTimer(session) {\n    if (session?.idleTimer) clearTimeout(session.idleTimer);\n    if (session) session.idleTimer = null;\n}\n\nfunction scheduleSessionIdleExpiry(token, session) {`,
    `function clearSessionIdleTimer(session) {\n    if (session?.idleTimer) clearTimeout(session.idleTimer);\n    if (session) session.idleTimer = null;\n}\n\nfunction cancelPendingClose(session) {\n    if (!session?.closeTimer) return false;\n    clearTimeout(session.closeTimer);\n    session.closeTimer = null;\n    return true;\n}\n\nfunction scheduleSessionIdleExpiry(token, session) {`,
    'pending close helper',
  );

  service = replaceRequired(
    service,
    `function touchSession(token, session) {\n    if (sessions.get(token) !== session) return false;\n    scheduleSessionIdleExpiry(token, session);\n    return true;\n}`,
    `function touchSession(token, session) {\n    if (sessions.get(token) !== session) return false;\n    cancelPendingClose(session);\n    scheduleSessionIdleExpiry(token, session);\n    return true;\n}`,
    'keepalive renewal',
  );

  service = replaceRequired(
    service,
    `async function touchEditorSession(token, session, { activity = false } = {}) {\n    if (activity && !touchSession(token, session)) {\n        return { ok: false, reason: 'expired' };\n    }\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    `async function touchEditorSession(token, session) {\n    // Every heartbeat proves that the editor page is still open. Keep both the\n    // web session and Discord builder hold alive even when the user is idle.\n    if (!touchSession(token, session)) {\n        return { ok: false, reason: 'expired' };\n    }\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    'heartbeat renews editor lease',
  );

  service = replaceRequired(
    service,
    `        idleTimer: null,\n    };`,
    `        idleTimer: null,\n        closeTimer: null,\n    };`,
    'session close timer state',
  );

  service = replaceRequired(
    service,
    `    if (value === CLOSE_PREFIX) {\n        // Closing/leaving the browser editor releases the Discord hold. The\n        // normal five-minute builder inactivity timer starts again immediately.\n        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n        scheduleSessionIdleExpiry(token, session);\n        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };\n    }`,
    `    if (value === CLOSE_PREFIX) {\n        // Browser unload events can race with an immediate reload, especially on\n        // iPhone/Safari. Mark the local hold inactive now so a returning page can\n        // refresh it, but only release the real Discord hold after a short grace.\n        // Any heartbeat/activity from the still-open editor cancels this close.\n        session.holdActive = false;\n        cancelPendingClose(session);\n        session.closeTimer = setTimeout(() => {\n            if (sessions.get(token) !== session) return;\n            session.closeTimer = null;\n            releaseBuilderSessionHold(token);\n            scheduleSessionIdleExpiry(token, session);\n        }, EMBED_EDITOR_CLOSE_GRACE_MS);\n        session.closeTimer.unref?.();\n        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };\n    }`,
    'reload-safe close handshake',
  );

  service = replaceRequired(
    service,
    `    if (value === HEARTBEAT_PREFIX) {\n        // Heartbeats prove the page is still connected, but they are not user\n        // activity and therefore must not keep the 14-minute idle timer alive.\n        const held = await touchEditorSession(token, session);`,
    `    if (value === HEARTBEAT_PREFIX) {\n        // A heartbeat proves the editor is still open, even when the user does\n        // nothing. It renews the 14-minute fallback lease and keeps the hold.\n        const held = await touchEditorSession(token, session);`,
    'heartbeat semantics comment',
  );

  service = replaceRequired(
    service,
    `    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    clearSessionIdleTimer(session);`,
    `    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    if (session?.closeTimer) clearTimeout(session.closeTimer);\n    clearSessionIdleTimer(session);`,
    'session close timer cleanup',
  );

  fs.writeFileSync(servicePath, service, 'utf8');
  console.log('[EMBED_EDITOR_OPEN_LEASE] session heartbeat lease + reload-safe close patched');
} else {
  console.log('[EMBED_EDITOR_OPEN_LEASE] session service already current');
}

let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(pageMarker)) {
  page = replaceRequired(
    page,
    `      if (!token || document.visibilityState !== 'visible' || heartbeatInFlight) return;`,
    `      if (!token || heartbeatInFlight) return; // ${pageMarker}: keep the lease alive whenever the browser can run timers`,
    'hidden-tab heartbeat gate',
  );
  fs.writeFileSync(pagePath, page, 'utf8');
  console.log('[EMBED_EDITOR_OPEN_LEASE] page heartbeat no longer stops merely because the tab is hidden');
} else {
  console.log('[EMBED_EDITOR_OPEN_LEASE] page heartbeat already current');
}

console.log('[EMBED_EDITOR_OPEN_LEASE] complete');
