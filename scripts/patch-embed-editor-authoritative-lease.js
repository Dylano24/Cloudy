import fs from 'node:fs';

const cleanupPath = 'src/utils/builderSessionCleanup.js';
const marker = 'EDITOR_AUTHORITATIVE_LEASE_V1';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EMBED_EDITOR_AUTH_LEASE] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let cleanup = fs.readFileSync(cleanupPath, 'utf8');
if (!cleanup.includes(marker)) {
  cleanup = replaceRequired(
    cleanup,
    `function isBuilderSessionHeld(messageId) {\n  return (sessionHoldIds.get(String(messageId || ''))?.size || 0) > 0;\n}`,
    `// ${marker}: this is the single authoritative boundary used by every\n// Builder deletion path while Edit title and message / Color Picker owns it.\nexport function isBuilderSessionHeld(messageId) {\n  return (sessionHoldIds.get(String(messageId || ''))?.size || 0) > 0;\n}`,
    'export held-state guard',
  );

  cleanup = replaceRequired(
    cleanup,
    `  const originalWebhookSend = InteractionWebhook.prototype.send;\n  const originalWebhookEditMessage = InteractionWebhook.prototype.editMessage;\n  const originalWebhookFetchMessage = InteractionWebhook.prototype.fetchMessage;`,
    `  const originalWebhookSend = InteractionWebhook.prototype.send;\n  const originalWebhookEditMessage = InteractionWebhook.prototype.editMessage;\n  const originalWebhookFetchMessage = InteractionWebhook.prototype.fetchMessage;\n  const originalWebhookDeleteMessage = InteractionWebhook.prototype.deleteMessage;\n  const originalMessageDelete = Message.prototype.delete;`,
    'capture raw delete methods',
  );

  cleanup = replaceRequired(
    cleanup,
    `  if (typeof originalWebhookFetchMessage === 'function') {\n    InteractionWebhook.prototype.fetchMessage = async function fetchBuilderSessionMessage(...args) {\n      const message = await originalWebhookFetchMessage.apply(this, args);\n      touchWebhookMessage(this, message);\n      return message;\n    };\n  }\n}`,
    `  if (typeof originalWebhookFetchMessage === 'function') {\n    InteractionWebhook.prototype.fetchMessage = async function fetchBuilderSessionMessage(...args) {\n      const message = await originalWebhookFetchMessage.apply(this, args);\n      touchWebhookMessage(this, message);\n      return message;\n    };\n  }\n\n  // ${marker}: Interaction#deleteReply ultimately deletes through the webhook.\n  // Guard both an explicit message id and Discord's @original alias so no\n  // alternate cleanup can bypass the active 14-minute editor lease.\n  if (typeof originalWebhookDeleteMessage === 'function') {\n    InteractionWebhook.prototype.deleteMessage = async function deleteBuilderLeaseAware(messageId, ...args) {\n      let targetId = String(messageId || '');\n      if (targetId === '@original' && typeof originalWebhookFetchMessage === 'function') {\n        const original = await originalWebhookFetchMessage.call(this, '@original').catch(() => null);\n        targetId = String(original?.id || '');\n      }\n      if (targetId && isBuilderSessionHeld(targetId)) {\n        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked webhook delete for held Builder ' + targetId);\n        return undefined;\n      }\n      return originalWebhookDeleteMessage.call(this, messageId, ...args);\n    };\n  }\n\n  // Cover direct Message#delete calls too. This is intentionally limited to a\n  // recognized Builder that currently has an editor/post-close hold.\n  if (typeof originalMessageDelete === 'function') {\n    Message.prototype.delete = function deleteBuilderLeaseAware(...args) {\n      if (isBuilderSessionMessage(this) && isBuilderSessionHeld(this.id)) {\n        console.warn('[EMBED_EDITOR_AUTH_LEASE] blocked direct delete for held Builder ' + this.id);\n        return Promise.resolve(this);\n      }\n      return originalMessageDelete.apply(this, args);\n    };\n  }\n}`,
    'central delete guards',
  );

  fs.writeFileSync(cleanupPath, cleanup, 'utf8');
  console.log('[EMBED_EDITOR_AUTH_LEASE] all Builder delete routes now respect the active editor lease');
} else {
  console.log('[EMBED_EDITOR_AUTH_LEASE] authoritative delete guard already current');
}
