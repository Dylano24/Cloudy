import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'EMBED_BUILDER_COLLECTOR_END_HOLD_V1';

let source = fs.readFileSync(path, 'utf8');

if (!source.includes(marker)) {
  const before = `            collector.on('end', async () => {\n                if (state.activeEmbedManager) {\n                    state.activeEmbedManager.closed = true;\n                    state.activeEmbedManager.collector?.stop('builder-ended');\n                    state.activeEmbedManager = null;\n                }\n                deleteEmbedColorPickerSession(colorSessionToken);\n            });`;

  const after = `            collector.on('end', async (_collected, reason) => {\n                // ${marker}: the editor lease owns its own lifetime. A component\n                // collector ending for idle/unknown/browser reasons must never\n                // release the active 14-minute Builder hold. Only the explicit\n                // Builder cleanup path may destroy the editor session.\n                if (reason !== 'builder-cleanup') return;\n\n                if (state.activeEmbedManager) {\n                    state.activeEmbedManager.closed = true;\n                    state.activeEmbedManager.collector?.stop('builder-ended');\n                    state.activeEmbedManager = null;\n                }\n                deleteEmbedColorPickerSession(colorSessionToken);\n            });`;

  if (!source.includes(before)) {
    console.error('[EMBED_BUILDER_COLLECTOR_END_HOLD] target collector end block not found');
    process.exit(1);
  }

  source = source.replace(before, after);
  fs.writeFileSync(path, source, 'utf8');
}

console.log('[EMBED_BUILDER_COLLECTOR_END_HOLD] only explicit Builder cleanup can release the editor session');
