import fs from 'node:fs';

const path = 'src/utils/builderSessionCleanup.js';
const marker = 'BUILDER_LINKED_EDITOR_HOLD_V1';
let source = fs.readFileSync(path, 'utf8');
if (!source.includes(marker)) {
  const replacements = [
    ['const parentSessions = new Map();', `const parentSessions = new Map();
const linkedChildMessages = new Map(); // ${marker}`],
    ['  parentSessions.set(String(childMessage.id), parentMessage);', `  parentSessions.set(String(childMessage.id), parentMessage);
  linkedChildMessages.set(String(childMessage.id), childMessage);
  // A child opened after the editor must inherit the existing hold too.
  // Preserve any post-close expiry: linking is not reopening the editor.
  const linkedHolds = new Set([
    ...(sessionHoldIds.get(String(parentMessage.id)) || []),
    ...(sessionHoldIds.get(String(childMessage.id)) || []),
  ]);
  for (const holdId of linkedHolds) {
    holdBuilderSessionMessage(childMessage, holdId, null, new Set(), true);
  }`],
    ['function holdBuilderSessionMessage(message, holdId, deleteMessage = null) {',
      'function holdBuilderSessionMessage(message, holdId, deleteMessage = null, visited = new Set(), preserveScheduledExpiry = false) {'],
    ['  observeBuilder(message);\n\n  // EDITOR_POST_CLOSE_FIVE_MIN_V1', `  observeBuilder(message);
  if (visited.has(String(message.id))) return true;
  visited.add(String(message.id));

  // EDITOR_POST_CLOSE_FIVE_MIN_V1`],
    ['  clearScheduledHoldExpiry(holdId);', '  if (!preserveScheduledExpiry) clearScheduledHoldExpiry(holdId);'],
    ['  clearBuilderSessionTimer(key);\n  return true;\n}\n\n// EDITOR_OPEN_HOLD_RACE_V3', `  clearBuilderSessionTimer(key);
  disableNativeBuilderCollectorIdle(sessionCollectors.get(key));
  // Share the actual hold membership, so every existing deletion guard and
  // the editor expiry operate on both the canonical Builder and Modify embed.
  const parent = parentSessions.get(key);
  if (parent) holdBuilderSessionMessage(parent, holdId, null, visited, preserveScheduledExpiry);
  for (const [childId, linkedParent] of parentSessions) {
    if (String(linkedParent.id) !== key) continue;
    const child = linkedChildMessages.get(childId);
    if (child) holdBuilderSessionMessage(child, holdId, null, visited, preserveScheduledExpiry);
  }
  return true;
}

// EDITOR_OPEN_HOLD_RACE_V3`],
    ['  parentSessions.delete(key);', '  parentSessions.delete(key);\n  linkedChildMessages.delete(key);'],
  ];
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error('Linked editor hold anchor missing: ' + before);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}
console.log('[BUILDER_LINKED_HOLD] canonical Builder and Modify embed share editor holds');
