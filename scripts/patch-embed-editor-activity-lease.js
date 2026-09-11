import fs from 'node:fs';

const pagePath = 'src/web/embedColorPickerPage.js';
const marker = 'EMBED_EDITOR_ACTIVITY_LEASE_V1';

let source = fs.readFileSync(pagePath, 'utf8');
if (!source.includes(marker)) {
  const oldBlock = `    const heartbeatTimer = setInterval(() => {\n      void keepEditorSessionActive();\n    }, 20_000);\n    window.addEventListener('focus', () => { void keepEditorSessionActive(); });\n    document.addEventListener('visibilitychange', () => {\n      if (document.visibilityState === 'visible') void keepEditorSessionActive();\n    });`;

  const newBlock = `    // ${marker}: entering/re-entering and real editor activity reset the\n    // shared fourteen-minute editor + Builder inactivity lease. Heartbeats keep\n    // the hold attached but do not extend inactivity by themselves.\n    let activityInFlight = false;\n    let lastActivitySignalAt = 0;\n    async function signalEditorActivity(force = false) {\n      if (!token || activityInFlight) return;\n      const now = Date.now();\n      if (!force && now - lastActivitySignalAt < 1_000) return;\n      lastActivitySignalAt = now;\n      activityInFlight = true;\n      try {\n        await callSession('__CLOUDY_EMBED_ACTIVITY__');\n      } catch {\n        // Actual save/apply actions surface errors. Activity pings stay silent.\n      } finally {\n        activityInFlight = false;\n      }\n    }\n\n    const heartbeatTimer = setInterval(() => {\n      void keepEditorSessionActive();\n    }, 20_000);\n    window.addEventListener('focus', () => { void signalEditorActivity(true); });\n    document.addEventListener('visibilitychange', () => {\n      if (document.visibilityState === 'visible') void signalEditorActivity(true);\n    });\n    for (const eventName of ['pointerdown', 'keydown', 'input']) {\n      window.addEventListener(eventName, () => { void signalEditorActivity(); }, { passive: true });\n    }`;

  if (!source.includes(oldBlock)) {
    console.error('[EMBED_EDITOR_ACTIVITY_LEASE] heartbeat block not found');
    process.exit(1);
  }
  source = source.replace(oldBlock, newBlock);

  const initialHeartbeat = `    void keepEditorSessionActive();\n\n    if (mode === 'content' || mode === 'footer') {`;
  const initialActivity = `    void signalEditorActivity(true);\n    void keepEditorSessionActive();\n\n    if (mode === 'content' || mode === 'footer') {`;
  if (!source.includes(initialHeartbeat)) {
    console.error('[EMBED_EDITOR_ACTIVITY_LEASE] initial editor heartbeat marker not found');
    process.exit(1);
  }
  source = source.replace(initialHeartbeat, initialActivity);

  fs.writeFileSync(pagePath, source, 'utf8');
}

console.log('[EMBED_EDITOR_ACTIVITY_LEASE] entering/re-entering and real editor activity reset the shared 14-minute lease');
