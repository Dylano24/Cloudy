import fs from 'node:fs';

const sessionPath = 'src/services/embedColorPickerSessionService.js';
const builderPath = 'src/commands/Tools/embedbuilder.js';
const marker = 'EDITOR_UPDATE_COALESCING_V1';

function replaceRequired(text, find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[EDITOR_UPDATE_COALESCING] marker not found (${label})`);
    process.exit(1);
  }
  return text.replace(find, replace);
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = replaceRequired(
    session,
    'const EDIT_FLUSH_DELAY_MS = 0;',
    `const EDIT_FLUSH_DELAY_MS = 2; // ${marker}: collapse same-field bursts without visible UI delay`,
    'editor flush delay',
  );

  session = replaceRequired(
    session,
    'export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, emojis = [] }) {',
    'export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, onEditorHold, emojis = [] }) {',
    'session callback signature',
  );

  session = replaceRequired(
    session,
    '        onEditorUpdate,\n        emojis: sanitizeEmojis(emojis),',
    '        onEditorUpdate,\n        onEditorHold,\n        emojis: sanitizeEmojis(emojis),',
    'store hold callback',
  );

  session = replaceRequired(
    session,
    "        await runWithBuilderSessionHold(token, () => session.onEditorUpdate('__heartbeat__', ''));",
    "        await runWithBuilderSessionHold(token, async () => {\n            if (typeof session.onEditorHold === 'function') await session.onEditorHold();\n        });",
    'separate heartbeat from content callback',
  );

  session = replaceRequired(
    session,
    `        const nextValue = payload.value.slice(0, limit);\n        try {\n            await session.onEditorUpdate(field, nextValue);\n        } catch (error) {\n            if (error?.code !== 'EMBED_BUILDER_EXPIRED') throw error;\n        }\n        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`,
    `        const nextValue = payload.value.slice(0, limit);\n        queueEditorUpdate(token, session, field, nextValue);\n        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`,
    'restore coalesced editor queue',
  );

  fs.writeFileSync(sessionPath, session, 'utf8');
  console.log('[EDITOR_UPDATE_COALESCING] session service patched');
} else {
  console.log('[EDITOR_UPDATE_COALESCING] session service already current');
}

let builder = fs.readFileSync(builderPath, 'utf8');
if (!builder.includes(marker)) {
  builder = replaceRequired(
    builder,
    `                getEditorState: () => ({\n                    title: state.title || '',\n                    message: state.message || '',\n                    footer: state.bottomLine || '',\n                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],\n                }),\n                onEditorUpdate: async (field, value) => {`,
    `                getEditorState: () => ({\n                    title: state.title || '',\n                    message: state.message || '',\n                    footer: state.bottomLine || '',\n                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],\n                }),\n                onEditorHold: async () => { // ${marker}\n                    const refreshed = await refreshBuilder(interaction, state);\n                    if (!refreshed) {\n                        const error = new Error('The message builder session has expired.');\n                        error.code = 'EMBED_BUILDER_EXPIRED';\n                        throw error;\n                    }\n                },\n                onEditorUpdate: async (field, value) => {`,
    'builder hold callback',
  );

  fs.writeFileSync(builderPath, builder, 'utf8');
  console.log('[EDITOR_UPDATE_COALESCING] builder callback patched');
} else {
  console.log('[EDITOR_UPDATE_COALESCING] builder callback already current');
}

console.log('[EDITOR_UPDATE_COALESCING] complete');
