// Embed Builder Save must preserve the exact serialized editor value.
// The browser serializer already converts indentation controls to Discord-safe
// visible blank glyphs before updating the live preview. Reflowing or replacing
// those characters again here would make the published embed differ from it.
export function normalizeManualIndent(value) {
  return String(value ?? '');
}
