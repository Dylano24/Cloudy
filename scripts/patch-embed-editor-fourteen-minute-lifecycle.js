import fs from 'node:fs';

const servicePath = 'src/services/embedColorPickerSessionService.js';
const marker = 'EDITOR_14_MINUTE_LEASE_V1';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_14_MIN] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let service = fs.readFileSync(servicePath, 'utf8');
if (!service.includes(marker)) {
  service = replaceRequired(
    service,
    `    session.idleTimer = setTimeout(() => {\n        if (sessions.get(token) === session) {\n            // EDITOR_OPEN_LEASE_V2: once the browser editor has established its hold, it\n            // must never expire merely because the user is idle or iOS freezes\n            // page timers. Only a confirmed close/cleanup may release it.\n            if (session.holdActive) {\n                session.idleTimer = null;\n                return;\n            }\n            deleteEmbedColorPickerSession(token, { expireBuilder: true });\n        }\n    }, EMBED_EDITOR_IDLE_MS);`,
    `    session.idleTimer = setTimeout(() => {\n        if (sessions.get(token) === session) {\n            // ${marker}: Edit title and message / Color Picker own a 14-minute\n            // inactivity lease. When it expires, the editor session and its held\n            // Discord Embed Builder expire together.\n            deleteEmbedColorPickerSession(token, { expireBuilder: true });\n        }\n    }, EMBED_EDITOR_IDLE_MS);`,
    'restore fourteen-minute editor expiry',
  );

  service = replaceRequired(
    service,
    `function touchSession(token, session) {\n    if (sessions.get(token) !== session) return false;\n    cancelPendingClose(session);\n    if (session.holdActive) {\n        clearSessionIdleTimer(session);\n    } else {\n        scheduleSessionIdleExpiry(token, session);\n    }\n    return true;\n}`,
    `function touchSession(token, session) {\n    if (sessions.get(token) !== session) return false;\n    cancelPendingClose(session);\n    // ${marker}: real editor activity restarts the full 14-minute lease even\n    // while the Discord Builder hold is active.\n    scheduleSessionIdleExpiry(token, session);\n    return true;\n}`,
    'activity restarts fourteen-minute lease',
  );

  service = replaceRequired(
    service,
    `            session.holdActive = true;\n            clearSessionIdleTimer(session);`,
    `            session.holdActive = true;\n            // ${marker}: holding the Builder suppresses its normal five-minute\n            // cleanup, but it must not disable the editor's 14-minute lease.`,
    'hold keeps editor expiry active',
  );

  service = replaceRequired(
    service,
    `async function touchEditorSession(token, session) {\n    // Every heartbeat proves that the editor page is still open. Once its hold\n    // exists there is intentionally no inactivity expiry at all.\n    if (!touchSession(token, session)) {\n        return { ok: false, reason: 'expired' };\n    }\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    `async function touchEditorSession(token, session, { activity = false } = {}) {\n    // ${marker}: heartbeat only proves the page still exists; it must not keep\n    // the 14-minute inactivity timer alive forever. Real editor activity does.\n    if (activity && !touchSession(token, session)) {\n        return { ok: false, reason: 'expired' };\n    }\n    const held = await ensureEditorHold(token, session);\n    if (!held.ok) return held;\n    return { ok: true };\n}`,
    'heartbeat does not extend editor inactivity',
  );

  service = replaceRequired(
    service,
    `    if (value !== CLOSE_PREFIX && instanceId) {\n        session.activeEditorInstanceId = instanceId;\n        cancelPendingClose(session);\n    }`,
    `    if (value !== CLOSE_PREFIX && instanceId) {\n        const openedNewEditorPage = session.activeEditorInstanceId !== instanceId;\n        session.activeEditorInstanceId = instanceId;\n        cancelPendingClose(session);\n        // ${marker}: opening or reopening either web editor starts a fresh\n        // 14-minute window for both the editor and the held Embed Builder.\n        if (openedNewEditorPage) touchSession(token, session);\n    }`,
    'reopening editor restarts fourteen minutes',
  );

  service = service.replace(
    `        // A heartbeat proves the editor remains open. After the first successful\n        // hold there is no inactivity expiry; this only maintains/reacquires it.`,
    `        // A heartbeat only maintains/reacquires the Builder hold. It does not\n        // count as user activity for the 14-minute editor inactivity window.`,
  );

  fs.writeFileSync(servicePath, service, 'utf8');
  console.log('[EMBED_EDITOR_14_MIN] editor + Embed Builder now share the requested 14-minute editor inactivity lease');
  console.log('[EMBED_EDITOR_14_MIN] opening/reopening starts a fresh 14 minutes; outside the editor Builder remains five-minute inactivity');
} else {
  console.log('[EMBED_EDITOR_14_MIN] lifecycle already current');
}
