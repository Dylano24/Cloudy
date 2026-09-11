import fs from 'node:fs';

const marker = 'EMBED_EDITOR_EXACT_OPEN_LEASE_V2';
const pagePath = 'src/web/embedColorPickerPage.js';
const appPath = 'src/app.js';
const sessionPath = 'src/services/embedColorPickerSessionService.js';
const cleanupPath = 'src/utils/builderSessionCleanup.js';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_EXACT_LEASE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

// Browser lifecycle: each loaded editor page has one unique identity. Opening
// that page starts one fixed 14-minute lease. Normal editor activity never
// restarts it. Closing the page explicitly releases the Builder hold.
let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(marker)) {
  page = replaceRequired(
    page,
    `    const apiUrl = '/api/embed-color/' + encodeURIComponent(token || '');`,
    `    const apiUrl = '/api/embed-color/' + encodeURIComponent(token || '');\n    // ${marker}: one browser document = one fixed editor lease.\n    const editorInstanceId = globalThis.crypto?.randomUUID?.()\n      || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));`,
    'editor instance id',
  );

  page = replaceRequired(
    page,
    `        body: JSON.stringify({ color: value }),`,
    `        body: JSON.stringify({ color: value, editorInstanceId }),`,
    'instance id on editor requests',
  );

  page = replaceRequired(
    page,
    `      return data.color;\n    }\n\n    let heartbeatInFlight = false;`,
    `      return data.color;\n    }\n\n    // Opening/reopening is the ONLY action that starts a fresh 14 minutes.\n    // Every other request waits for this handshake but never extends it.\n    const editorOpenPromise = token\n      ? callSession('__CLOUDY_EMBED_OPEN__:' + editorInstanceId)\n      : Promise.resolve(null);\n\n    let heartbeatInFlight = false;`,
    'fixed editor-open handshake',
  );

  page = replaceRequired(
    page,
    `      if (!token || document.visibilityState !== 'visible' || heartbeatInFlight) return;\n      heartbeatInFlight = true;\n      try {\n        await callSession('__CLOUDY_EMBED_HEARTBEAT__');`,
    `      if (!token || heartbeatInFlight) return;\n      heartbeatInFlight = true;\n      try {\n        await editorOpenPromise;\n        await callSession('__CLOUDY_EMBED_HEARTBEAT__');`,
    'heartbeat keeps hold but never owns the 14-minute timer',
  );

  const closeStart = page.indexOf('    function closeEditorSession() {');
  const closeEndMarker = `    window.addEventListener('beforeunload', closeEditorSession, { once: true });`;
  const closeEnd = page.indexOf(closeEndMarker, closeStart);
  if (closeStart === -1 || closeEnd === -1) {
    console.error('[EMBED_EDITOR_EXACT_LEASE] editor close lifecycle block not found');
    process.exit(1);
  }
  const afterClose = closeEnd + closeEndMarker.length;
  const closeLifecycle = `    let editorCloseSent = false;\n    function closeEditorSession() {\n      if (editorCloseSent) return;\n      editorCloseSent = true;\n      clearInterval(heartbeatTimer);\n      if (!token) return;\n      const payload = JSON.stringify({\n        color: '__CLOUDY_EMBED_CLOSE__',\n        editorInstanceId,\n      });\n      try {\n        if (typeof navigator.sendBeacon === 'function') {\n          const blob = new Blob([payload], { type: 'application/json' });\n          if (navigator.sendBeacon(apiUrl, blob)) return;\n        }\n      } catch {}\n      try {\n        void fetch(apiUrl, {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: payload,\n          keepalive: true,\n        }).catch(() => {});\n      } catch {}\n    }\n    // pagehide covers mobile/in-app browser exits; beforeunload is the desktop\n    // fallback. visibilitychange is deliberately NOT a close signal.\n    window.addEventListener('pagehide', closeEditorSession, { once: true });\n    window.addEventListener('beforeunload', closeEditorSession, { once: true });`;
  page = `${page.slice(0, closeStart)}${closeLifecycle}${page.slice(afterClose)}`;

  page = replaceRequired(
    page,
    `          const raw = await callSession('__CLOUDY_EMBED_STATE__');`,
    `          await editorOpenPromise;\n          const raw = await callSession('__CLOUDY_EMBED_STATE__');`,
    'state waits for open lease',
  );

  page = replaceRequired(
    page,
    `try { await callSession(hex.value); status.textContent = 'Color applied to your Discord preview.';`,
    `try { await editorOpenPromise; await callSession(hex.value); status.textContent = 'Color applied to your Discord preview.';`,
    'color apply waits for open lease',
  );

  fs.writeFileSync(pagePath, page, 'utf8');
}

// Forward the unique browser document identity to the session service. A stale
// close/heartbeat from an older page can therefore never take ownership from a
// newly reopened editor.
let app = fs.readFileSync(appPath, 'utf8');
if (!app.includes(marker)) {
  app = replaceRequired(
    app,
    `        const result = await applyEmbedColorPickerSession(req.params.token, req.body?.color);`,
    `        // ${marker}: forward the page identity for exact open/close ownership.\n        const result = await applyEmbedColorPickerSession(\n          req.params.token,\n          req.body?.color,\n          { editorInstanceId: req.body?.editorInstanceId },\n        );`,
    'API forwards editor instance id',
  );
  fs.writeFileSync(appPath, app, 'utf8');
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = replaceRequired(
    session,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst CLOSE_PREFIX = '__CLOUDY_EMBED_CLOSE__';`,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:'; // ${marker}\nconst CLOSE_PREFIX = '__CLOUDY_EMBED_CLOSE__';`,
    'open control prefix',
  );

  session = replaceRequired(
    session,
    'const SESSION_IDLE_MS = 14 * 60_000;',
    `export const EMBED_EDITOR_IDLE_MS = 14 * 60_000; // ${marker}`,
    'fixed fourteen-minute constant',
  );

  session = replaceRequired(
    session,
    `function scheduleSessionIdleExpiry(token, session) {\n    clearSessionIdleTimer(session);\n    session.idleTimer = setTimeout(() => {\n        if (sessions.get(token) === session) deleteEmbedColorPickerSession(token);\n    }, SESSION_IDLE_MS);\n    session.idleTimer.unref?.();\n}`,
    `function scheduleSessionIdleExpiry(token, session, editorInstanceId) {\n    clearSessionIdleTimer(session);\n    const instanceId = String(editorInstanceId || '');\n    session.idleTimer = setTimeout(() => {\n        session.idleTimer = null;\n        if (sessions.get(token) !== session) return;\n        if (!instanceId || session.activeEditorInstanceId !== instanceId) return;\n\n        // Exactly 14 minutes after OPEN, the web editor lease ends. The Builder\n        // itself does NOT disappear here: it returns to its normal fresh five-\n        // minute inactivity window, exactly like an explicit editor close.\n        session.expiredEditorInstanceIds.add(instanceId);\n        session.activeEditorInstanceId = null;\n        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n    }, EMBED_EDITOR_IDLE_MS);\n    session.idleTimer.unref?.();\n}`,
    'fixed editor lease expiry releases to Builder five-minute mode',
  );

  session = replaceRequired(
    session,
    `function touchSession(token, session) {\n    scheduleSessionIdleExpiry(token, session);\n}\n`,
    `function normalizeEditorInstanceId(value) {\n    return typeof value === 'string' ? value.trim().slice(0, 128) : '';\n}\n\nasync function openEditorLease(token, session, instanceId) {\n    if (!instanceId) return { ok: false, reason: 'editor_instance_required' };\n    if (session.closedEditorInstanceIds.has(instanceId)\n        || session.expiredEditorInstanceIds.has(instanceId)) {\n        return { ok: false, reason: 'editor_expired' };\n    }\n\n    if (session.activeEditorInstanceId !== instanceId) {\n        // A genuinely new browser document is a reopen and therefore starts a\n        // fresh fixed 14 minutes. Duplicate OPEN from the same document does not.\n        session.activeEditorInstanceId = instanceId;\n        scheduleSessionIdleExpiry(token, session, instanceId);\n    }\n\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}\n\nfunction requireActiveEditorInstance(session, instanceId) {\n    if (!instanceId || session.activeEditorInstanceId !== instanceId) {\n        return { ok: false, reason: 'editor_expired' };\n    }\n    return { ok: true };\n}\n`,
    'replace activity-based timer helper with page-open lease helper',
  );

  session = replaceRequired(
    session,
    `async function touchEditorSession(token, session) {\n    touchSession(token, session);\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    `async function touchEditorSession(token, session) {\n    // Heartbeat only verifies/maintains the hold. It NEVER restarts 14 minutes.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    'heartbeat never resets editor lease',
  );

  session = replaceRequired(
    session,
    `        idleTimer: null,\n    };\n    sessions.set(token, session);\n    scheduleSessionIdleExpiry(token, session);\n    return token;`,
    `        idleTimer: null,\n        activeEditorInstanceId: null, // ${marker}\n        closedEditorInstanceIds: new Set(),\n        expiredEditorInstanceIds: new Set(),\n    };\n    sessions.set(token, session);\n    // The 14-minute clock starts only when Editor/Color Picker is actually opened.\n    return token;`,
    'session starts editor timer only on open',
  );

  session = replaceRequired(
    session,
    `export async function applyEmbedColorPickerSession(token, value) {\n    const session = sessions.get(token);\n    if (!session) {\n        return { ok: false, reason: 'expired' };\n    }\n\n    touchSession(token, session);\n\n    if (value === CLOSE_PREFIX) {\n        // Closing/leaving the browser editor no longer destroys the token.\n        // It simply releases the Discord hold and starts a fresh 14-minute idle window.\n        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n        scheduleSessionIdleExpiry(token, session);\n        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };\n    }\n\n    if (value === HEARTBEAT_PREFIX) {\n        const touched = await touchEditorSession(token, session);\n        if (!touched.ok) return touched;\n        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };\n    }\n\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;`,
    `export async function applyEmbedColorPickerSession(token, value, { editorInstanceId = null } = {}) {\n    const session = sessions.get(token);\n    if (!session) {\n        return { ok: false, reason: 'expired' };\n    }\n\n    const instanceId = normalizeEditorInstanceId(editorInstanceId);\n\n    if (typeof value === 'string' && value.startsWith(OPEN_PREFIX)) {\n        const requestedId = normalizeEditorInstanceId(value.slice(OPEN_PREFIX.length));\n        if (!instanceId || requestedId !== instanceId) {\n            return { ok: false, reason: 'editor_instance_required' };\n        }\n        const opened = await openEditorLease(token, session, instanceId);\n        if (!opened.ok) return opened;\n        return { ok: true, color: JSON.stringify({ type: 'editor_opened' }) };\n    }\n\n    if (value === CLOSE_PREFIX) {\n        if (!instanceId) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };\n        }\n        session.closedEditorInstanceIds.add(instanceId);\n        if (session.activeEditorInstanceId !== instanceId) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };\n        }\n\n        clearSessionIdleTimer(session);\n        session.activeEditorInstanceId = null;\n        session.holdActive = false;\n        // Closing the editor starts a fresh normal five-minute Builder window.\n        releaseBuilderSessionHold(token);\n        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };\n    }\n\n    const active = requireActiveEditorInstance(session, instanceId);\n    if (!active.ok) return active;\n\n    if (value === HEARTBEAT_PREFIX) {\n        const touched = await touchEditorSession(token, session);\n        if (!touched.ok) return touched;\n        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };\n    }\n\n    // State reads, typing, emoji changes and color changes are activity inside\n    // the already-open editor, but deliberately do NOT restart its fixed 14m.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;`,
    'exact open close and non-reset activity semantics',
  );

  session = replaceRequired(
    session,
    `export function deleteEmbedColorPickerSession(token) {\n    const session = sessions.get(token);\n    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    clearSessionIdleTimer(session);\n    sessions.delete(token);\n    releaseBuilderSessionHold(token);\n}`,
    `export function deleteEmbedColorPickerSession(token) {\n    const session = sessions.get(token);\n    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);\n    clearSessionIdleTimer(session);\n    sessions.delete(token);\n    releaseBuilderSessionHold(token);\n}`,
    'session cleanup remains a normal release',
  );

  fs.writeFileSync(sessionPath, session, 'utf8');
}

// Builder lifecycle: its normal five-minute inactivity timer is authoritative
// only outside the editor. While held, clear both our timer and discord.js'
// native collector idle timer. This removes every independent five-minute path.
let cleanup = fs.readFileSync(cleanupPath, 'utf8');
if (!cleanup.includes(marker)) {
  cleanup = replaceRequired(
    cleanup,
    `export function registerBuilderSessionCollector(message, collector) {\n  if (!isBuilderSessionMessage(message) || !collector) return false;\n  sessionCollectors.set(String(message.id), collector);`,
    `function disableNativeBuilderCollectorIdle(collector) {\n  // ${marker}: resetTimer({ idle: null }) is not relied upon as a disable switch.\n  // Clear the native timeout directly; our Builder timer owns the 5m lifecycle.\n  if (collector?._idletimeout) clearTimeout(collector._idletimeout);\n  if (collector && '_idletimeout' in collector) collector._idletimeout = null;\n  if (collector?.options && typeof collector.options === 'object') {\n    delete collector.options.idle;\n  }\n}\n\nexport function registerBuilderSessionCollector(message, collector) {\n  if (!isBuilderSessionMessage(message) || !collector) return false;\n  disableNativeBuilderCollectorIdle(collector);\n  sessionCollectors.set(String(message.id), collector);`,
    'native collector idle guard',
  );

  cleanup = replaceRequired(
    cleanup,
    `  if (activeHoldId) {\n    collector?.resetTimer?.({ idle: null });\n    holdBuilderSessionMessage(message, activeHoldId, deleteMessage);\n  } else if (isBuilderSessionHeld(key)) {\n    collector?.resetTimer?.({ idle: null });\n    clearBuilderSessionTimer(key);`,
    `  if (activeHoldId) {\n    disableNativeBuilderCollectorIdle(collector);\n    holdBuilderSessionMessage(message, activeHoldId, deleteMessage);\n  } else if (isBuilderSessionHeld(key)) {\n    disableNativeBuilderCollectorIdle(collector);\n    clearBuilderSessionTimer(key);`,
    'held Builder has no independent native idle timer',
  );

  cleanup = replaceRequired(
    cleanup,
    `export async function deleteBuilderSessionMessage(message) {\n  if (!message?.id) return false;\n\n  const key = String(message.id);\n  clearBuilderSessionTimer(key);`,
    `export async function deleteBuilderSessionMessage(message) {\n  if (!message?.id) return false;\n\n  const key = String(message.id);\n  // ${marker}: while Editor/Color Picker owns this Builder, no cleanup route\n  // is allowed to remove it. Closing/14m expiry releases the hold first.\n  if (isBuilderSessionHeld(key)) return false;\n  clearBuilderSessionTimer(key);`,
    'hard held-Builder deletion guard',
  );

  fs.writeFileSync(cleanupPath, cleanup, 'utf8');
}

console.log('[EMBED_EDITOR_EXACT_LEASE] Builder: 5m inactivity outside editor, reset by Builder activity');
console.log('[EMBED_EDITOR_EXACT_LEASE] Editor/Color Picker: fixed 14m per open; activity does not reset; close returns to fresh 5m');
