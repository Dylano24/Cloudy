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
