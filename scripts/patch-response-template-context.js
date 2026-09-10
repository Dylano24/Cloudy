import fs from 'node:fs';

const path = 'src/services/systemEmbedCatalogService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;
const marker = 'SOURCE_RESPONSE_CONTEXT_V1';

if (text.includes(marker)) {
  console.log('[SOURCE_RESPONSE_CONTEXT] already current');
  process.exit(0);
}

function replaceOnce(find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[SOURCE_RESPONSE_CONTEXT] marker not found (${label})`);
    process.exit(1);
  }
  text = text.replace(find, replace);
}

replaceOnce(
`function normalizeDiscoveredDefinition(definition = {}) {
  const key = sourceDefinitionKey(definition);
  return key ? { ...definition, key } : definition;
}`,
`function normalizeDiscoveredDefinition(definition = {}) {
  const key = sourceDefinitionKey(definition);
  if (!key) return definition;
  // SOURCE_RESPONSE_CONTEXT_V1: plain responses are feature-scoped so a static
  // source definition and its runtime interaction resolve the same template.
  const context = parentContext(definition.context) || normalize(definition.context);
  return { ...definition, key, context };
}`,
'feature-scoped source context');

replaceOnce(
`      if (metadata.kind !== 'content' || normalize(metadata.context) !== normalize(entry.context)) continue;`,
`      const metadataContext = normalize(metadata.context);
      const entryContext = normalize(entry.context);
      if (metadata.kind !== 'content'
        || !(metadataContext === entryContext || parentContext(metadataContext) === entryContext)) continue;`,
'legacy child-context migration');

replaceOnce(
`  const stableKey = plainSourceAliases.get(plainSourceAliasIdentity(context, content)) || null;`,
`  const stableKey = plainSourceAliases.get(plainSourceAliasIdentity(context, content))
    || plainSourceAliases.get(plainSourceAliasIdentity(parentContext(context), content))
    || null;`,
'runtime parent alias fallback');

if (!text.includes(marker)) {
  console.error('[SOURCE_RESPONSE_CONTEXT] final marker missing');
  process.exit(1);
}

fs.writeFileSync(path, text, 'utf8');
console.log('[SOURCE_RESPONSE_CONTEXT] patched source/runtime feature-context parity');
