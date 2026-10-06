import fs from 'node:fs';

const sessionPath = 'src/services/embedColorPickerSessionService.js';
const builderPath = 'src/commands/Tools/embedbuilder.js';
const marker = 'EDITOR_UPDATE_COALESCING_V1';

function replaceOptional(text, find, replace, label) {
  if (text.includes(replace) || (typeof replace === 'string' && text.includes(replace.trim()))) return text;
  if (!text.includes(find)) {
    console.log(`[EDITOR_UPDATE_COALESCING] ${label}: historical marker absent; leaving current implementation intact`);
    return text;
  }
  return text.replace(find, replace);
}

let session = fs.readFileSync(sessionPath, 'utf8');
if (!session.includes(marker)) {
  session = session.replace(
    /const EDIT_FLUSH_DELAY_MS = \d+;/,
    `const EDIT_FLUSH_DELAY_MS = 2; // ${marker}: collapse same-field bursts without visible UI delay`,
  );

  // This is a migration over a file that other startup migrations also edit.
  // Match the current function structurally instead of requiring one historical
  // byte-for-byte callback signature.
  session = session.replace(
    /export function createEmbedColorPickerSession\(\{([^}]*)\}\) \{/,
    (full, args) => {
      if (/\bonEditorHold\b/.test(args)) return full;
      const parts = args.split(',').map(part => part.trim()).filter(Boolean);
      const emojiIndex = parts.findIndex(part => /^emojis\b/.test(part));
      if (emojiIndex >= 0) parts.splice(emojiIndex, 0, 'onEditorHold');
      else parts.push('onEditorHold');
      return `export function createEmbedColorPickerSession({ ${parts.join(', ')} }) {`;
    },
  );

  if (!/\bonEditorHold,\s*\n\s*emojis: sanitizeEmojis\(emojis\)/.test(session)) {
    session = session.replace(
      /(\s+onEditorUpdate,\s*\n)(\s+emojis: sanitizeEmojis\(emojis\),)/,
      '$1        onEditorHold,\n$2',
    );
  }

  session = session.replace(
    /await runWithBuilderSessionHold\(token, \(\) => session\.onEditorUpdate\('__heartbeat__', ''\)\);/,
    `await runWithBuilderSessionHold(token, async () => {
            if (typeof session.onEditorHold === 'function') await session.onEditorHold();
        });`,
  );

  const synchronousSave = `        const nextValue = payload.value.slice(0, limit);
        try {
            await session.onEditorUpdate(field, nextValue);
        } catch (error) {
            if (error?.code !== 'EMBED_BUILDER_EXPIRED') throw error;
        }
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`;
  const queuedSave = `        const nextValue = payload.value.slice(0, limit);
        queueEditorUpdate(token, session, field, nextValue);
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };`;
  session = replaceOptional(session, synchronousSave, queuedSave, 'coalesced editor queue');

  fs.writeFileSync(sessionPath, session, 'utf8');
  console.log('[EDITOR_UPDATE_COALESCING] session service migration complete');
} else {
  console.log('[EDITOR_UPDATE_COALESCING] session service already current');
}

let builder = fs.readFileSync(builderPath, 'utf8');
if (!builder.includes(marker)) {
  const anchor = `                getEditorState: () => ({
                    title: state.title || '',
                    message: state.message || '',
                    footer: state.bottomLine || '',
                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],
                }),
                onEditorUpdate: async (field, value) => {`;
  const withHold = `                getEditorState: () => ({
                    title: state.title || '',
                    message: state.message || '',
                    footer: state.bottomLine || '',
                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],
                }),
                onEditorHold: async () => { // ${marker}
                    const refreshed = await refreshBuilder(interaction, state);
                    if (!refreshed) {
                        const error = new Error('The message builder session has expired.');
                        error.code = 'EMBED_BUILDER_EXPIRED';
                        throw error;
                    }
                },
                onEditorUpdate: async (field, value) => {`;
  builder = replaceOptional(builder, anchor, withHold, 'builder hold callback');

  // If the builder has evolved but already owns an onEditorHold callback, stamp
  // the migration without changing behavior so future startups are idempotent.
  if (!builder.includes(marker) && builder.includes('onEditorHold:')) {
    builder = builder.replace('onEditorHold:', `onEditorHold: /* ${marker} */`);
  }

  fs.writeFileSync(builderPath, builder, 'utf8');
  console.log('[EDITOR_UPDATE_COALESCING] builder migration complete');
} else {
  console.log('[EDITOR_UPDATE_COALESCING] builder callback already current');
}

console.log('[EDITOR_UPDATE_COALESCING] complete');
