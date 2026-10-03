import fs from 'node:fs';

function edit(file, before, after) {
  const text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Balance patch anchor missing: ${file}`);
  fs.writeFileSync(file, text.replace(before, after));
}

edit('src/services/embedTemplateService.js',
  "  const pattern = dynamicParts(value).pattern;\n\n  // Dynamic response families",
  "  const pattern = dynamicParts(value).pattern;\n  // Legacy Builder masters used the plain Balance title. Resolve those Saves\n  // for every member, including after the catalog has applied the saved title.\n  if (raw === 'balance' || pattern === \"{dynamic}'s balance\") {\n    return [...new Set([\"{dynamic}'s balance\", raw, 'balance'].filter(Boolean))];\n  }\n\n  // Dynamic response families");

edit('src/services/systemEmbedCatalogService.js',
  "  if (template.title) next.title = renderDynamic(template.title, data.title, { fallbackToRuntimeOnMismatch: true });",
  "  if (template.title) {\n    const memberPrefix = context === 'gambling/balance'\n      ? String(data.title || '').match(/^(.+'s\\s+)/i)?.[1] : null;\n    const savedTitle = memberPrefix && !/^(?:.+?'s\\s+|\\{dynamic\\})/i.test(template.title)\n      ? memberPrefix + template.title : template.title;\n    next.title = renderDynamic(savedTitle, data.title, { fallbackToRuntimeOnMismatch: true });\n  }");

edit('src/services/embedManagerService.js',
  "import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from './embedTemplateService.js';",
  "import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from './embedTemplateService.js';\nimport { removeRetiredGamblingGuideCommand, isRetiredGamblingEmbed } from '../config/gamblingCommands.js';");
edit('src/services/embedManagerService.js',
  "        const raw = record.snapshot || getEmbedRegistrySnapshot(record) || recordEmbedData(record);\n        const saved =",
  "        const raw = record.snapshot || getEmbedRegistrySnapshot(record) || recordEmbedData(record);\n        if (isRetiredGamblingEmbed(raw)) continue;\n        const saved =");
edit('src/services/embedManagerService.js',
  "        const snapshot = saved.matched ? saved.data : hydrated;",
  "        const snapshot = removeRetiredGamblingGuideCommand(saved.matched ? saved.data : hydrated);");

edit('src/services/embedTemplateService.js',
  "import { PRESERVE_EXISTING_EMBEDS } from './existingEmbedPolicy.js';",
  "import { PRESERVE_EXISTING_EMBEDS } from './existingEmbedPolicy.js';\nimport { removeRetiredGamblingGuideCommand } from '../config/gamblingCommands.js';");
edit('src/services/embedTemplateService.js',
  "    migrateCloudyLogoEmbedData(template).data || template,",
  "    removeRetiredGamblingGuideCommand(migrateCloudyLogoEmbedData(template).data || template),");
edit('src/services/embedTemplateService.js',
  "  const data = { ...original };\n\n  const template =",
  "  const data = removeRetiredGamblingGuideCommand({ ...original });\n\n  const template =");
edit('src/services/embedTemplateService.js',
  "  if (!template) return { matched: false, data: embedData };",
  "  if (!template) return { matched: false, data: removeRetiredGamblingGuideCommand(embedData) };");

console.log('[PATCH] Balance member titles and retired gambling command filtering applied.');
