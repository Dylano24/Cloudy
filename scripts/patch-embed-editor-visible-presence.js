import fs from 'node:fs';

const marker = 'EMBED_EDITOR_AUTHORITATIVE_HOLD_V5';
const pagePath = 'src/web/embedColorPickerPage.js';
const sessionPath = 'src/services/embedColorPickerSessionService.js';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_AUTHORITATIVE_HOLD] marker not found (${label})`);
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

  const closeStart = page.indexOf('    let editorCloseSent = false;');
  const closeEndMarker = `    window.addEventListener('beforeunload', closeEditorSession, { once: true });`;
  const closeEnd = page.indexOf(closeEndMarker, closeStart);
  if (closeStart === -1 || closeEnd === -1) {
    console.error('[EMBED_EDITOR_AUTHORITATIVE_HOLD] exact-open browser close lifecycle block not found');
    process.exit(1);
  }

  const afterClose = closeEnd + closeEndMarker.length;
  const authoritativeLifecycle = `    // ${marker}: browser visibility/page lifecycle is deliberately NOT\n    // authoritative for the editor hold. Once this page opens, the Builder\n    // remains protected for the fixed server-side fourteen-minute lease.\n    // Switching back to Discord, backgrounding Safari, pagehide and unload\n    // must never start the Builder's five-minute inactivity timer early.\n`;
  page = `${page.slice(0, closeStart)}${authoritativeLifecycle}${page.slice(afterClose)}`;

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

  const closeHandler = `    if (value === CLOSE_PREFIX) {\n        // A no-ID close can be a stale cached page, so it may never release a newer page.\n        if (!explicitInstanceId) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };\n        }\n        session.closedEditorInstanceIds.add(instanceId);\n        if (session.activeEditorInstanceId !== instanceId) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };\n        }\n\n        clearSessionIdleTimer(session);\n        session.activeEditorInstanceId = null;\n        session.holdActive = false;\n        // Closing starts a fresh normal 5m Builder inactivity window.\n        releaseBuilderSessionHold(token);\n        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };\n    }`;

  const authoritativeHandler = `    if (value === PAUSE_PREFIX || value === CLOSE_PREFIX) {\n        // ${marker}: mobile/browser lifecycle events are not reliable proof that\n        // the editor has truly ended. Ignore them completely. The fixed 14m\n        // lease created by OPEN is the only authority that can release the hold.\n        return { ok: true, color: JSON.stringify({ type: 'editor_lifecycle_ignored' }) };\n    }`;

  session = replaceRequired(
    session,
    closeHandler,
    authoritativeHandler,
    'browser lifecycle cannot release fixed editor hold',
  );

  const heartbeatBefore = `async function touchEditorSession(token, session) {\n    // Heartbeat keeps the hold attached but NEVER restarts 14m.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`;

  const heartbeatAfter = `async function touchEditorSession(token, session) {\n    // ${marker}: heartbeat NEVER restarts the fixed 14m lease, but it does\n    // re-edit the exact same Discord Builder preview while the web editor is\n    // open. iOS/Discord can otherwise discard a stale ephemeral panel when the\n    // in-app browser is closed after several minutes, even though the server\n    // hold is still valid.\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n\n    if (typeof session.onEditorUpdate !== 'function') {\n        return { ok: false, reason: 'editor_unavailable' };\n    }\n\n    try {\n        await runWithBuilderSessionHold(\n            token,\n            () => session.onEditorUpdate('__heartbeat__', ''),\n        );\n        session.holdActive = true;\n    } catch (error) {\n        if (error?.code === 'EMBED_BUILDER_EXPIRED') {\n            session.holdActive = false;\n            return { ok: true, previewUnavailable: true };\n        }\n        throw error;\n    }\n\n    return { ok: true };\n}`;

  session = replaceRequired(
    session,
    heartbeatBefore,
    heartbeatAfter,
    'heartbeat keeps the Discord Builder preview warm without resetting 14m',
  );

  fs.writeFileSync(sessionPath, session, 'utf8');
}

console.log('[EMBED_EDITOR_AUTHORITATIVE_HOLD] fixed 14m editor lease owns Builder hold; 20s heartbeat also keeps the same Discord preview visible');
