import fs from 'node:fs';

const cleanupPath = 'src/utils/builderSessionCleanup.js';
const servicePath = 'src/services/embedColorPickerSessionService.js';
const marker = 'EDITOR_POST_CLOSE_FIVE_MIN_V1';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_POST_CLOSE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let cleanup = fs.readFileSync(cleanupPath, 'utf8');
if (!cleanup.includes(marker)) {
  cleanup = replaceRequired(
    cleanup,
    `const holdMessages = new Map();\nconst editorHoldContext = new AsyncLocalStorage();`,
    `const holdMessages = new Map();\nconst scheduledHoldExpiries = new Map(); // ${marker}\nconst editorHoldContext = new AsyncLocalStorage();`,
    'scheduled hold expiry state',
  );

  cleanup = replaceRequired(
    cleanup,
    `function holdBuilderSessionMessage(message, holdId, deleteMessage = null) {`,
    `function clearScheduledHoldExpiry(holdId) {\n  const id = String(holdId || '');\n  const timer = scheduledHoldExpiries.get(id);\n  if (timer) clearTimeout(timer);\n  scheduledHoldExpiries.delete(id);\n}\n\nexport function scheduleBuilderSessionHoldExpiry(holdId, delay = BUILDER_SESSION_IDLE_MS) {\n  const id = String(holdId || '');\n  const messages = holdMessages.get(id);\n  if (!id || !messages?.size) return false;\n\n  clearScheduledHoldExpiry(id);\n  const timer = setTimeout(() => {\n    scheduledHoldExpiries.delete(id);\n    void expireBuilderSessionHold(id);\n  }, delay);\n  timer.unref?.();\n  scheduledHoldExpiries.set(id, timer);\n  return true;\n}\n\nfunction refreshScheduledHoldExpiryForMessage(messageId) {\n  const holds = sessionHoldIds.get(String(messageId || ''));\n  if (!holds?.size) return;\n  for (const holdId of holds) {\n    if (scheduledHoldExpiries.has(holdId)) {\n      scheduleBuilderSessionHoldExpiry(holdId, BUILDER_SESSION_IDLE_MS);\n    }\n  }\n}\n\nfunction holdBuilderSessionMessage(message, holdId, deleteMessage = null) {`,
    'post-close hold helpers',
  );

  cleanup = replaceRequired(
    cleanup,
    `  if (!isBuilderSessionMessage(message) || !holdId) return false;\n\n  const key = String(message.id);`,
    `  if (!isBuilderSessionMessage(message) || !holdId) return false;\n\n  // ${marker}: reopening/actively owning the editor cancels any pending\n  // post-close expiry so the Builder remains protected while the editor is open.\n  clearScheduledHoldExpiry(holdId);\n\n  const key = String(message.id);`,
    'cancel expiry on active editor hold',
  );

  cleanup = replaceRequired(
    cleanup,
    `export function releaseBuilderSessionHold(holdId) {\n  const id = String(holdId || '');`,
    `export function releaseBuilderSessionHold(holdId) {\n  const id = String(holdId || '');\n  clearScheduledHoldExpiry(id);`,
    'clear scheduled expiry on release',
  );

  cleanup = replaceRequired(
    cleanup,
    `export async function expireBuilderSessionHold(holdId) {\n  const id = String(holdId || '');`,
    `export async function expireBuilderSessionHold(holdId) {\n  const id = String(holdId || '');\n  clearScheduledHoldExpiry(id);`,
    'clear scheduled expiry on expire',
  );

  cleanup = replaceRequired(
    cleanup,
    `  } else if (isBuilderSessionHeld(key)) {\n    collector?.resetTimer?.({ idle: null });\n    clearBuilderSessionTimer(key);`,
    `  } else if (isBuilderSessionHeld(key)) {\n    collector?.resetTimer?.({ idle: null });\n    clearBuilderSessionTimer(key);\n    // ${marker}: while the editor is closed but its five-minute protection is\n    // still active, any Discord Builder interaction restarts the full window.\n    refreshScheduledHoldExpiryForMessage(key);`,
    'restart protected window on Builder activity',
  );

  fs.writeFileSync(cleanupPath, cleanup, 'utf8');
  console.log('[EMBED_EDITOR_POST_CLOSE] five-minute protected Builder hold patched');
} else {
  console.log('[EMBED_EDITOR_POST_CLOSE] Builder hold protection already current');
}

let service = fs.readFileSync(servicePath, 'utf8');
if (!service.includes(marker)) {
  service = replaceRequired(
    service,
    `    expireBuilderSessionHold,\n    releaseBuilderSessionHold,\n    runWithBuilderSessionHold,`,
    `    BUILDER_SESSION_IDLE_MS,\n    expireBuilderSessionHold,\n    releaseBuilderSessionHold,\n    runWithBuilderSessionHold,\n    scheduleBuilderSessionHoldExpiry,`,
    'session cleanup imports',
  );

  service = replaceRequired(
    service,
    `            session.closeTimer = null;\n            session.holdActive = false;\n            releaseBuilderSessionHold(token);\n            scheduleSessionIdleExpiry(token, session);`,
    `            session.closeTimer = null;\n            session.holdActive = false;\n            // ${marker}: leaving the web editor must NEVER make the Discord\n            // Builder disappear immediately. Keep the real hold registered for\n            // a full five-minute inactivity window, then expire the Builder.\n            // Reopening the editor cancels this countdown; Builder activity\n            // restarts it through builderSessionCleanup.\n            const protectedForFiveMinutes = scheduleBuilderSessionHoldExpiry(\n                token,\n                BUILDER_SESSION_IDLE_MS,\n            );\n            if (!protectedForFiveMinutes) releaseBuilderSessionHold(token);\n            scheduleSessionIdleExpiry(token, session);`,
    'five-minute protected close behavior',
  );

  fs.writeFileSync(servicePath, service, 'utf8');
  console.log('[EMBED_EDITOR_POST_CLOSE] editor close now guarantees a full five-minute protected Builder window');
} else {
  console.log('[EMBED_EDITOR_POST_CLOSE] editor close behavior already current');
}

console.log('[EMBED_EDITOR_POST_CLOSE] complete');
