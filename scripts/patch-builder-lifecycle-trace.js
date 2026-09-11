import fs from 'node:fs';

// Observability only; run after all existing lifecycle patches.
const changes = {
  "src/utils/builderSessionCleanup.js": [
    [
      "import { AsyncLocalStorage } from 'node:async_hooks';",
      "import { AsyncLocalStorage } from 'node:async_hooks';\nimport { traceBuilder, traceHoldId, traceDeleteAttempt, observeBuilder, observeBuilderCollector, rememberBuilderWebhook, installBuilderLifecycleTrace } from './builderLifecycleTrace.js';"
    ],
    [
      "const editorHoldContext = new AsyncLocalStorage();",
      "const editorHoldContext = new AsyncLocalStorage();\n\nexport function traceEditorHold(event, holdId, details = {}) {\n  const messages = holdMessages.get(String(holdId || ''));\n  const ids = messages?.size ? [...messages.keys()] : [null];\n  for (const id of ids) traceBuilder(event, id, {\n    holdId: traceHoldId(holdId), linkedMessageCount: messages?.size || 0, ...details,\n  });\n}\n"
    ],
    [
      "  sessionCollectors.set(String(message.id), collector);",
      "  observeBuilderCollector(message, collector);\n  sessionCollectors.set(String(message.id), collector);"
    ],
    [
      "  parentSessions.set(String(childMessage.id), parentMessage);",
      "  traceBuilder('parent_linked', childMessage.id, { parentMessageId: String(parentMessage.id) });\n  parentSessions.set(String(childMessage.id), parentMessage);"
    ],
    [
      "  if (!isBuilderSessionMessage(message) || !holdId) return false;",
      "  if (!isBuilderSessionMessage(message) || !holdId) {\n    traceBuilder('hold_bind_rejected', message?.id, { holdId: traceHoldId(holdId) });\n    return false;\n  }\n  observeBuilder(message);"
    ],
    [
      "  messages.set(key, message);",
      "  messages.set(key, message);\n  traceBuilder('hold_bound', key, { holdId: traceHoldId(holdId) });"
    ],
    [
      "export function releaseBuilderSessionHold(holdId) {",
      "export function releaseBuilderSessionHold(holdId) {\n  traceEditorHold('hold_release', holdId);"
    ],
    [
      "export async function expireBuilderSessionHold(holdId) {",
      "export async function expireBuilderSessionHold(holdId) {\n  traceEditorHold('hold_expire', holdId);"
    ],
    [
      "  clearScheduledHoldExpiry(id);\n  const timer = setTimeout(() => {",
      "  clearScheduledHoldExpiry(id);\n  traceEditorHold('post_close_timer_scheduled', id, { delayMs: delay, expiresAt: new Date(Date.now() + delay).toISOString() });\n  const timer = setTimeout(() => {\n    traceEditorHold('post_close_timer_fired', id);"
    ],
    [
      "  if (isBuilderSessionHeld(key)) return false;",
      "  traceDeleteAttempt('deleteBuilderSessionMessage', key);\n  if (isBuilderSessionHeld(key)) traceBuilder('delete_blocked', key, { route: 'deleteBuilderSessionMessage' });\n  if (isBuilderSessionHeld(key)) return false;"
    ],
    [
      "  if (!isBuilderSessionMessage(message)) return false;\n\n  const key",
      "  if (!isBuilderSessionMessage(message)) return false;\n  observeBuilder(message);\n\n  const key"
    ],
    [
      "    const timer = setTimeout(() => {\n      sessionTimers.delete(key);",
      "    traceBuilder('builder_timer_scheduled', key, { delayMs: BUILDER_SESSION_IDLE_MS, expiresAt: new Date(Date.now() + BUILDER_SESSION_IDLE_MS).toISOString() });\n    const timer = setTimeout(() => {\n      traceBuilder('builder_timer_fired', key);\n      sessionTimers.delete(key);"
    ],
    [
      "export function installBuilderSessionCleanup() {",
      "export function installBuilderSessionCleanup() {\n  installBuilderLifecycleTrace(id => ({\n    holdActive: isBuilderSessionHeld(id),\n    holdIds: [...(sessionHoldIds.get(id) || [])].map(traceHoldId),\n    collectorEndReason: sessionCollectors.get(id)?.endReason ?? null,\n    parentMessageId: parentSessions.get(id)?.id ?? null,\n    builderTimerActive: sessionTimers.has(id),\n  }));"
    ],
    [
      "    const collector = originalCreateCollector.call(this, collectorOptions);",
      "    const collector = originalCreateCollector.call(this, collectorOptions);\n    if (isBuilderSessionMessage(this)) observeBuilderCollector(this, collector);"
    ],
    [
      "    const message = await originalWebhookEditMessage.apply(this, args);",
      "    const message = await originalWebhookEditMessage.apply(this, args);\n    rememberBuilderWebhook(this, message, args[0]);"
    ],
    [
      "      const message = await originalWebhookFetchMessage.apply(this, args);",
      "      const message = await originalWebhookFetchMessage.apply(this, args);\n      rememberBuilderWebhook(this, message, args[0]);"
    ],
    [
      "      let targetId = String(messageId || '');",
      "      traceDeleteAttempt('InteractionWebhook.deleteMessage', messageId);\n      let targetId = String(messageId || '');"
    ],
    [
      "        targetId = String(original?.id || '');",
      "        targetId = String(original?.id || '');\n        rememberBuilderWebhook(this, original, '@original');\n        traceBuilder('original_resolved', targetId, { resolved: Boolean(targetId) });"
    ],
    [
      "        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked webhook delete for held Builder ' + targetId);",
      "        traceBuilder('delete_blocked', targetId, { route: 'InteractionWebhook.deleteMessage' });\n        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked webhook delete for held Builder ' + targetId);"
    ],
    [
      "    Message.prototype.delete = function deleteBuilderLeaseAware(...args) {",
      "    Message.prototype.delete = function deleteBuilderLeaseAware(...args) {\n      traceDeleteAttempt('Message.delete', this.id);"
    ],
    [
      "        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked direct delete for held Builder ' + this.id);",
      "        traceBuilder('delete_blocked', this.id, { route: 'Message.delete' });\n        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked direct delete for held Builder ' + this.id);"
    ]
  ],
  "src/services/embedColorPickerSessionService.js": [
    [
      "import { randomBytes } from 'node:crypto';",
      "import { randomBytes } from 'node:crypto';\nimport { traceEditorHold } from '../utils/builderSessionCleanup.js';"
    ],
    [
      "function scheduleSessionIdleExpiry(token, session) {",
      "function scheduleSessionIdleExpiry(token, session) {\n    traceEditorHold('editor_timer_scheduled', token, { delayMs: EMBED_EDITOR_IDLE_MS, expiresAt: new Date(Date.now() + EMBED_EDITOR_IDLE_MS).toISOString(), sessionHoldActive: session.holdActive });"
    ],
    [
      "            deleteEmbedColorPickerSession(token, { expireBuilder: true });",
      "            traceEditorHold('editor_timer_fired', token);\n            deleteEmbedColorPickerSession(token, { expireBuilder: true });"
    ],
    [
      "    if (session.holdActive) return { ok: true };",
      "    if (session.holdActive) {\n        traceEditorHold('editor_hold_reused', token, { sessionHoldActive: true });\n        return { ok: true };\n    }"
    ],
    [
      "            session.holdActive = true;",
      "            session.holdActive = true;\n            traceEditorHold('editor_hold_acquired', token, { sessionHoldActive: true, hasHoldCallback: typeof session.onEditorHold === 'function' });"
    ],
    [
      "        } catch (error) {\n            releaseBuilderSessionHold(token);",
      "        } catch (error) {\n            traceEditorHold('editor_hold_failed', token, { errorCode: error?.code ?? null });\n            releaseBuilderSessionHold(token);"
    ],
    [
      "    const instanceId = typeof editorInstanceId",
      "    traceEditorHold('editor_request', token, { requestKind: value === CLOSE_PREFIX ? 'close' : value === HEARTBEAT_PREFIX ? 'heartbeat' : value === ACTIVITY_PREFIX ? 'activity' : value === STATE_PREFIX ? 'state' : 'edit', sessionHoldActive: session.holdActive });\n    const instanceId = typeof editorInstanceId"
    ],
    [
      "        session.activeEditorInstanceId = null;",
      "        traceEditorHold('editor_close_accepted', token);\n        session.activeEditorInstanceId = null;"
    ],
    [
      "            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };",
      "            traceEditorHold('editor_close_ignored', token);\n            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };"
    ]
  ]
};
for (const [path, replacements] of Object.entries(changes)) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes('// BUILDER_LIFECYCLE_TRACE_V1')) continue;
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error('Builder trace anchor missing in ' + path + ': ' + before.slice(0, 80));
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source + '\n// BUILDER_LIFECYCLE_TRACE_V1\n');
}
console.log('[BUILDER_TRACE] diagnostic instrumentation ready');
