import fs from 'node:fs';

const marker = 'EMBED_EDITOR_VISIBLE_PRESENCE_V3';
const pagePath = 'src/web/embedColorPickerPage.js';
const sessionPath = 'src/services/embedColorPickerSessionService.js';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_VISIBLE_PRESENCE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(marker)) {
  page = replaceRequired(
    page,
    `      if (!token || heartbeatInFlight) return;`,
    `      if (!token || document.visibilityState !== 'visible' || heartbeatInFlight) return; // ${marker}`,
    'heartbeats only while the editor is actually visible',
  );

  page = replaceRequired(
    page,
    `    document.addEventListener('visibilitychange', () => {\n      if (document.visibilityState === 'visible') void keepEditorSessionActive();\n    });`,
    `    document.addEventListener('visibilitychange', () => {\n      if (document.visibilityState === 'hidden') {\n        pauseEditorSession();\n        return;\n      }\n      editorPauseSent = false;\n      void keepEditorSessionActive();\n    });`,
    'visibility owns Builder presence',
  );

  const closeStart = page.indexOf('    let editorCloseSent = false;');
  const closeEndMarker = `    window.addEventListener('beforeunload', closeEditorSession, { once: true });`;
  const closeEnd = page.indexOf(closeEndMarker, closeStart);
  if (closeStart === -1 || closeEnd === -1) {
    console.error('[EMBED_EDITOR_VISIBLE_PRESENCE] exact-open close lifecycle block not found');
    process.exit(1);
  }

  const afterClose = closeEnd + closeEndMarker.length;
  const presenceLifecycle = `    // ${marker}: leaving/hiding the editor pauses only the Builder hold.\n    // It never resets the page's fixed 14-minute editor lease. Returning to\n    // this same page resumes the hold without starting a new 14 minutes.\n    let editorPauseSent = false;\n    function pauseEditorSession() {\n      if (editorPauseSent || !token) return;\n      editorPauseSent = true;\n      const payload = JSON.stringify({\n        color: '__CLOUDY_EMBED_PAUSE__',\n        editorInstanceId,\n      });\n      try {\n        if (typeof navigator.sendBeacon === 'function') {\n          const blob = new Blob([payload], { type: 'application/json' });\n          if (navigator.sendBeacon(apiUrl, blob)) return;\n        }\n      } catch {}\n      try {\n        void fetch(apiUrl, {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: payload,\n          keepalive: true,\n        }).catch(() => {});\n      } catch {}\n    }\n    window.addEventListener('pagehide', pauseEditorSession);\n    window.addEventListener('beforeunload', pauseEditorSession);`;
  page = `${page.slice(0, closeStart)}${presenceLifecycle}${page.slice(afterClose)}`;

  fs.writeFileSync(pagePath, page, 'utf8');
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = replaceRequired(
    session,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:';`,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst PAUSE_PREFIX = '__CLOUDY_EMBED_PAUSE__'; // ${marker}\nconst OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:';`,
    'pause control prefix',
  );

  const openReturn = `        return { ok: true, color: JSON.stringify({ type: 'editor_opened' }) };\n    }\n\n    if (value === CLOSE_PREFIX) {`;
  const pauseHandler = `        return { ok: true, color: JSON.stringify({ type: 'editor_opened' }) };\n    }\n\n    if (value === PAUSE_PREFIX) {\n        // Hidden/left editor: immediately return the Builder to its normal\n        // five-minute inactivity mode, but keep this page's original 14m\n        // deadline intact so a resume cannot create a fresh editor lease.\n        if (!explicitInstanceId || session.activeEditorInstanceId !== instanceId) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_pause_ignored' }) };\n        }\n        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n        return { ok: true, color: JSON.stringify({ type: 'editor_paused' }) };\n    }\n\n    if (value === CLOSE_PREFIX) {`;
  session = replaceRequired(session, openReturn, pauseHandler, 'pause releases Builder without resetting editor lease');

  fs.writeFileSync(sessionPath, session, 'utf8');
}

console.log('[EMBED_EDITOR_VISIBLE_PRESENCE] fixed iOS lifecycle: visible editor holds Builder; hidden/closed editor returns to 5m; 14m never resets');

// Repair presence ordering in the existing startup patch; keep all lease durations.
const resumeMarker = "EMBED_EDITOR_PRESENCE_ORDER_V4";

let orderedPage = fs.readFileSync("src/web/embedColorPickerPage.js", "utf8");
if (!orderedPage.includes(resumeMarker)) {
  orderedPage = replaceRequired(orderedPage,
    "    async function callSession(value) {",
    "    let editorPresenceSequence = 0; // EMBED_EDITOR_PRESENCE_ORDER_V4\n    async function callSession(value) {",
    "presence sequence");
  orderedPage = replaceRequired(orderedPage,
    "body: JSON.stringify({ color: value, editorInstanceId }),",
    "body: JSON.stringify({ color: value, editorInstanceId, editorPresenceSequence: ++editorPresenceSequence }),",
    "sequence on requests");
  orderedPage = replaceRequired(orderedPage,
    "        color: '__CLOUDY_EMBED_PAUSE__',\n        editorInstanceId,",
    "        color: '__CLOUDY_EMBED_PAUSE__',\n        editorInstanceId,\n        editorPresenceSequence: ++editorPresenceSequence,",
    "sequence on beacon");
  orderedPage = replaceRequired(orderedPage,
    "        await editorOpenPromise;\n        await callSession('__CLOUDY_EMBED_HEARTBEAT__');",
    "        await editorOpenPromise;\n        if (document.visibilityState !== 'visible') return;\n        await callSession('__CLOUDY_EMBED_HEARTBEAT__');",
    "recheck visibility after opening");
  orderedPage = replaceRequired(orderedPage,
    "    window.addEventListener('pagehide', pauseEditorSession);",
    "    window.addEventListener('pageshow', () => {\n      editorPauseSent = false;\n      void keepEditorSessionActive();\n    });\n    window.addEventListener('pagehide', pauseEditorSession);",
    "restore cached pages");
  fs.writeFileSync("src/web/embedColorPickerPage.js", orderedPage, "utf8");
}

let orderedApp = fs.readFileSync("src/app.js", "utf8");
if (!orderedApp.includes(resumeMarker)) {
  orderedApp = replaceRequired(orderedApp,
    "{ editorInstanceId: req.body?.editorInstanceId },",
    "{ editorInstanceId: req.body?.editorInstanceId, editorPresenceSequence: req.body?.editorPresenceSequence }, // EMBED_EDITOR_PRESENCE_ORDER_V4",
    "forward sequence");
  fs.writeFileSync("src/app.js", orderedApp, "utf8");
}

let orderedSession = fs.readFileSync("src/services/embedColorPickerSessionService.js", "utf8");
if (!orderedSession.includes(resumeMarker)) {
  orderedSession = replaceRequired(orderedSession,
    "async function ensureEditorHold(token, session) {\n    if (session.holdActive) return { ok: true };\n    if (typeof session.onEditorUpdate !== 'function') {\n        return { ok: false, reason: 'editor_unavailable' };\n    }\n\n    try {\n        await runWithBuilderSessionHold(token, async () => {\n            if (typeof session.onEditorHold === 'function') await session.onEditorHold();\n        });\n        session.holdActive = true;\n    } catch (error) {\n        releaseBuilderSessionHold(token);\n        if (error?.code === 'EMBED_BUILDER_EXPIRED') {\n            // An old Discord interaction must not invalidate the browser editor.\n            // Keep accepting/saving editor state until the real 14-minute idle timer expires.\n            session.holdActive = false;\n            return { ok: true, previewUnavailable: true };\n        }\n        throw error;\n    }\n\n    return { ok: true };\n}\n",
    "async function ensureEditorHold(token, session) {\n    // EMBED_EDITOR_PRESENCE_ORDER_V4: a late callback cannot resurrect a released hold.\n    if (sessions.get(token) !== session || !session.activeEditorInstanceId || session.editorPaused) {\n        return { ok: true };\n    }\n    if (session.holdPending) {\n        await session.holdPending;\n        return ensureEditorHold(token, session);\n    }\n    if (session.holdActive) return { ok: true };\n    if (typeof session.onEditorUpdate !== 'function') return { ok: false, reason: 'editor_unavailable' };\n\n    const revision = session.holdRevision;\n    const pending = (async () => {\n        try {\n            await runWithBuilderSessionHold(token, async () => {\n                if (typeof session.onEditorHold === 'function') await session.onEditorHold();\n            });\n            if (sessions.get(token) !== session || revision !== session.holdRevision) {\n                releaseBuilderSessionHold(token);\n                session.holdActive = false;\n            } else {\n                session.holdActive = true;\n            }\n        } catch (error) {\n            releaseBuilderSessionHold(token);\n            session.holdActive = false;\n            if (error?.code === 'EMBED_BUILDER_EXPIRED') return { ok: true, previewUnavailable: true };\n            throw error;\n        }\n        return { ok: true };\n    })();\n    session.holdPending = pending;\n    let result;\n    try {\n        result = await pending;\n    } finally {\n        session.holdPending = null;\n    }\n    if (revision !== session.holdRevision) return ensureEditorHold(token, session);\n    return result;\n}\n",
    "coalesce and invalidate asynchronous holds");
  orderedSession = replaceRequired(orderedSession,
    "        holdActive: false,",
    "        holdActive: false,\n        holdPending: null,\n        holdRevision: 0,\n        editorPaused: false,\n        editorPresenceSequence: 0,",
    "presence state");
  orderedSession = replaceRequired(orderedSession,
    "async function openEditorLease(token, session, instanceId) {",
    "async function openEditorLease(token, session, instanceId, presenceSequence = 0) {",
    "open sequence argument");
  orderedSession = replaceRequired(orderedSession,
    "        session.activeEditorInstanceId = instanceId;\n        scheduleSessionIdleExpiry",
    "        session.holdRevision += 1;\n        session.editorPaused = false;\n        session.editorPresenceSequence = Number.isSafeInteger(presenceSequence) ? presenceSequence : 0;\n        session.activeEditorInstanceId = instanceId;\n        scheduleSessionIdleExpiry",
    "new page state");
  orderedSession = replaceRequired(orderedSession,
    "{ editorInstanceId = null } = {}) {",
    "{ editorInstanceId = null, editorPresenceSequence = null } = {}) {",
    "request sequence");
  orderedSession = replaceRequired(orderedSession,
    "    const instanceId = explicitInstanceId || '__legacy_editor__';",
    "    const instanceId = explicitInstanceId || '__legacy_editor__';\n    const presenceControl = value === HEARTBEAT_PREFIX || value === PAUSE_PREFIX\n        || value === CLOSE_PREFIX || (typeof value === 'string' && value.startsWith(OPEN_PREFIX));\n    if (presenceControl && explicitInstanceId && session.activeEditorInstanceId === instanceId) {\n        const sequence = Number.isSafeInteger(editorPresenceSequence) && editorPresenceSequence > 0\n            ? editorPresenceSequence : 0;\n        if (session.editorPresenceSequence > 0 && sequence <= session.editorPresenceSequence) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_presence_ignored' }) };\n        }\n        session.editorPresenceSequence = sequence;\n    }",
    "order control events");
  orderedSession = replaceRequired(orderedSession,
    "const opened = await openEditorLease(token, session, instanceId);",
    "const opened = await openEditorLease(token, session, instanceId, editorPresenceSequence);",
    "forward open sequence");
  orderedSession = replaceRequired(orderedSession,
    "        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n        return { ok: true, color: JSON.stringify({ type: 'editor_paused' }) };",
    "        session.holdRevision += 1;\n        session.editorPaused = true;\n        session.holdActive = false;\n        releaseBuilderSessionHold(token);\n        return { ok: true, color: JSON.stringify({ type: 'editor_paused' }) };",
    "pause invalidates acquisition");
  orderedSession = replaceRequired(orderedSession,
    "    if (value === HEARTBEAT_PREFIX) {\n        const touched",
    "    if (value === HEARTBEAT_PREFIX) {\n        if (session.editorPaused) session.holdRevision += 1;\n        session.editorPaused = false;\n        const touched",
    "resume presence");
  orderedSession = replaceRequired(orderedSession,
    "        session.expiredEditorInstanceIds.add(instanceId);",
    "        session.holdRevision += 1;\n        session.editorPaused = true;\n        session.expiredEditorInstanceIds.add(instanceId);",
    "expiry invalidates acquisition");
  orderedSession = replaceRequired(orderedSession,
    "        clearSessionIdleTimer(session);\n        session.activeEditorInstanceId = null;",
    "        session.holdRevision += 1;\n        session.editorPaused = true;\n        clearSessionIdleTimer(session);\n        session.activeEditorInstanceId = null;",
    "close invalidates acquisition");
  fs.writeFileSync("src/services/embedColorPickerSessionService.js", orderedSession, "utf8");
}

console.log("[EMBED_EDITOR_PRESENCE_ORDER] ordered pause/resume, guarded hold completion, cached-page resume; fixed 14m unchanged");
