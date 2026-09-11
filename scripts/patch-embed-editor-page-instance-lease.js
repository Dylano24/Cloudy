import fs from 'node:fs';

const pagePath = 'src/web/embedColorPickerPage.js';
const appPath = 'src/app.js';
const servicePath = 'src/services/embedColorPickerSessionService.js';
const cleanupPath = 'src/utils/builderSessionCleanup.js';
const marker = 'EDITOR_PAGE_INSTANCE_LEASE_V4';
const collectorMarker = 'BUILDER_NATIVE_IDLE_GUARD_V2';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_PAGE_INSTANCE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let page = fs.readFileSync(pagePath, 'utf8');
if (!page.includes(marker)) {
  page = replaceRequired(
    page,
    `    const apiUrl = '/api/embed-color/' + encodeURIComponent(token || '');`,
    `    const apiUrl = '/api/embed-color/' + encodeURIComponent(token || '');\n    // ${marker}: every loaded browser document owns a unique lease identity.\n    // A stale unload from an older/reloaded document must never close a newer one.\n    const editorInstanceId = globalThis.crypto?.randomUUID?.()\n      || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));`,
    'browser editor instance id',
  );

  page = replaceRequired(
    page,
    `        body: JSON.stringify({ color: value }),`,
    `        body: JSON.stringify({ color: value, editorInstanceId }),`,
    'editor request instance id',
  );

  page = replaceRequired(
    page,
    `      const payload = JSON.stringify({ color: '__CLOUDY_EMBED_CLOSE__' });`,
    `      const payload = JSON.stringify({\n        color: '__CLOUDY_EMBED_CLOSE__',\n        editorInstanceId,\n      });`,
    'close request instance id',
  );

  fs.writeFileSync(pagePath, page, 'utf8');
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] browser requests now carry a unique page instance id');
} else {
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] browser page instance id already current');
}

let app = fs.readFileSync(appPath, 'utf8');
if (!app.includes(marker)) {
  app = replaceRequired(
    app,
    `        const result = await applyEmbedColorPickerSession(req.params.token, req.body?.color);`,
    `        // ${marker}: forward the browser document identity so stale unloads\n        // cannot release the current editor lease.\n        const result = await applyEmbedColorPickerSession(\n          req.params.token,\n          req.body?.color,\n          { editorInstanceId: req.body?.editorInstanceId },\n        );`,
    'API forwards editor instance id',
  );
  fs.writeFileSync(appPath, app, 'utf8');
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] API now forwards editor page identity');
} else {
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] API page identity forwarding already current');
}

let service = fs.readFileSync(servicePath, 'utf8');
if (!service.includes(marker)) {
  service = replaceRequired(
    service,
    `        closeTimer: null,\n    };`,
    `        closeTimer: null,\n        activeEditorInstanceId: null, // ${marker}\n    };`,
    'session active editor instance state',
  );

  service = replaceRequired(
    service,
    `export async function applyEmbedColorPickerSession(token, value) {\n    const session = sessions.get(token);\n    if (!session) {\n        return { ok: false, reason: 'expired' };\n    }`,
    `export async function applyEmbedColorPickerSession(token, value, { editorInstanceId = null } = {}) {\n    const session = sessions.get(token);\n    if (!session) {\n        return { ok: false, reason: 'expired' };\n    }\n\n    const instanceId = typeof editorInstanceId === 'string'\n        ? editorInstanceId.trim().slice(0, 128)\n        : '';\n\n    // ${marker}: every non-close request makes that document the authoritative\n    // editor instance and cancels a pending unload from an older document.\n    if (value !== CLOSE_PREFIX && instanceId) {\n        session.activeEditorInstanceId = instanceId;\n        cancelPendingClose(session);\n    }`,
    'instance-aware apply signature',
  );

  service = replaceRequired(
    service,
    `    if (value === CLOSE_PREFIX) {\n        // Browser unload events can race with an immediate reload, especially on`,
    `    if (value === CLOSE_PREFIX) {\n        // ${marker}: ignore an unload from a browser document that is no longer\n        // authoritative. This handles both race orders: old CLOSE after new\n        // heartbeat, and old CLOSE before the new heartbeat.\n        if (!instanceId\n            || (session.activeEditorInstanceId\n                && session.activeEditorInstanceId !== instanceId)) {\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };\n        }\n        session.activeEditorInstanceId = null;\n\n        // Browser unload events can race with an immediate reload, especially on`,
    'stale close guard',
  );

  fs.writeFileSync(servicePath, service, 'utf8');
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] stale browser unloads can no longer release a newer editor hold');
} else {
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] server page-instance lease already current');
}

let cleanup = fs.readFileSync(cleanupPath, 'utf8');
if (!cleanup.includes(collectorMarker)) {
  cleanup = replaceRequired(
    cleanup,
    `export function registerBuilderSessionCollector(message, collector) {\n  if (!isBuilderSessionMessage(message) || !collector) return false;\n  sessionCollectors.set(String(message.id), collector);`,
    `function disableNativeBuilderCollectorIdle(collector) {\n  // ${collectorMarker}: discord.js 14.26.x resetTimer({ idle: null }) does NOT\n  // disable an existing idle timer; null falls back to the original idle value.\n  // The Builder lifecycle is therefore owned exclusively by sessionTimers/holds.\n  if (collector?._idletimeout) clearTimeout(collector._idletimeout);\n  if (collector && '_idletimeout' in collector) collector._idletimeout = null;\n  if (collector?.options && typeof collector.options === 'object') {\n    delete collector.options.idle;\n  }\n}\n\nexport function registerBuilderSessionCollector(message, collector) {\n  if (!isBuilderSessionMessage(message) || !collector) return false;\n  disableNativeBuilderCollectorIdle(collector);\n  sessionCollectors.set(String(message.id), collector);`,
    'native collector idle hardening',
  );

  fs.writeFileSync(cleanupPath, cleanup, 'utf8');
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] native discord.js Builder idle timer disabled');
} else {
  console.log('[EMBED_EDITOR_PAGE_INSTANCE] native Builder idle guard already current');
}

console.log('[EMBED_EDITOR_PAGE_INSTANCE] complete');
