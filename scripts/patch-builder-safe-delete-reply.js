import fs from 'node:fs';

const path = 'src/utils/interactionMessageLifecycle.js';
const marker = 'BUILDER_SAFE_DELETE_REPLY_FALLBACK_V1';
let source = fs.readFileSync(path, 'utf8');

if (!source.includes(marker)) {
  const before = `  if (interaction?.deleteReply) {\n    return interaction.deleteReply()\n      .then(() => true)\n      .catch(() => false);\n  }`;

  const after = `  // ${marker}: deleteReply() always targets the interaction's @original\n  // response, not the specific message passed to this cleanup function. A failed\n  // cleanup of a secondary ephemeral response must therefore never fall through\n  // and delete the Message Builder that happens to be @original.\n  if (interaction?.deleteReply && interaction?.fetchReply) {\n    const originalReply = await interaction.fetchReply().catch(() => null);\n    if (!originalReply?.id || String(originalReply.id) !== String(message.id)) {\n      return false;\n    }\n    if (isBuilderSessionMessage(originalReply)) {\n      clearBuilderLifecycleTimers(originalReply);\n      return false;\n    }\n    return interaction.deleteReply()\n      .then(() => true)\n      .catch(() => false);\n  }`;

  if (!source.includes(before)) {
    console.error('[BUILDER_SAFE_DELETE_REPLY] lifecycle fallback anchor not found');
    process.exit(1);
  }

  source = source.replace(before, after);
  fs.writeFileSync(path, source, 'utf8');
}

console.log('[BUILDER_SAFE_DELETE_REPLY] secondary cleanup can no longer delete @original Builder');
