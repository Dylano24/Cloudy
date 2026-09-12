import fs from 'node:fs';

const marker = 'EMBED_EDITOR_CLOSE_RETURNS_5M_V6';
const pagePath = 'src/web/embedColorPickerPage.js';
const sessionPath = 'src/services/embedColorPickerSessionService.js';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_CLOSE_RETURNS_5M] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(marker)) {
  page = replaceRequired(
    page,
    `      if (!token || heartbeatInFlight) return;`,
    `      if (!token || heartbeatInFlight) return; // ${marker}`,
    'editor heartbeat guard',
  );

  // The exact-open patch already installs the authoritative browser-close path:
  // pagehide/beforeunload sends CLOSE with this editorInstanceId. Keep that
  // lifecycle intact so leaving the editor releases the hold to a fresh 5m.
  if (!page.includes(`window.addEventListener('pagehide', closeEditorSession, { once: true });`)
      || !page.includes(`window.addEventListener('beforeunload', closeEditorSession, { once: true });`)
      || !page.includes(`color: '__CLOUDY_EMBED_CLOSE__'`)) {
    console.error('[EMBED_EDITOR_CLOSE_RETURNS_5M] exact editor close lifecycle not found');
    process.exit(1);
  }

  fs.writeFileSync(pagePath, page, 'utf8');
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = replaceRequired(
    session,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:';`,
    `const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';\nconst PAUSE_PREFIX = '__CLOUDY_EMBED_PAUSE__'; // ${marker}: compatibility with cached V3 pages\nconst OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:';`,
    'cached page lifecycle compatibility',
  );

  session = replaceRequired(
    session,
    `    if (value === CLOSE_PREFIX) {`,
    `    if (value === PAUSE_PREFIX) {\n        // A cached V3 page may still send PAUSE while merely backgrounded.\n        // PAUSE is not proof the editor was closed, so only explicit CLOSE\n        // releases the Builder hold and starts the normal fresh 5m window.\n        return { ok: true, color: JSON.stringify({ type: 'editor_lifecycle_ignored' }) };\n    }\n\n    if (value === CLOSE_PREFIX) {`,
    'pause stays non-authoritative while close returns to five-minute mode',
  );

  const heartbeatBefore = `async function touchEditorSession(token, session) {\n    // Heartbeat keeps the hold attached but NEVER restarts 14m.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`;

  const heartbeatAfter = `async function touchEditorSession(token, session) {\n    // ${marker}: heartbeat NEVER restarts the fixed 14m lease. It only\n    // refreshes the same Builder preview while the editor remains open.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n\n    if (typeof session.onEditorUpdate !== 'function') {\n        return { ok: false, reason: 'editor_unavailable' };\n    }\n\n    try {\n        await runWithBuilderSessionHold(\n            token,\n            () => session.onEditorUpdate('__heartbeat__', ''),\n        );\n        session.holdActive = true;\n    } catch (error) {\n        if (error?.code === 'EMBED_BUILDER_EXPIRED') {\n            session.holdActive = false;\n            return { ok: true, previewUnavailable: true };\n        }\n        throw error;\n    }\n\n    return { ok: true };\n}`;

  session = replaceRequired(
    session,
    heartbeatBefore,
    heartbeatAfter,
    'heartbeat keeps the existing Builder preview warm without resetting 14m',
  );

  fs.writeFileSync(sessionPath, session, 'utf8');
}

console.log('[EMBED_EDITOR_CLOSE_RETURNS_5M] editor open = fixed 14m hold; editor close = fresh 5m Builder inactivity; heartbeat does not reset 14m');
