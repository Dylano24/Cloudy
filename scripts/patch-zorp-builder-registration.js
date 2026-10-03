import fs from 'node:fs';

const path = 'src/services/embedRegistryService.js';
let source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
function replace(before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`ZORP registration anchor missing: ${before}`);
  source = source.replace(before, after);
}
replace('function isFixedCloudyEmbed(embed) {', `function isZorpGuideTitle(value) {
    const title = String(value || '').replace(/<a?:[^:>]+:\\d+>/g, '').replace(/^(?:\\s|☑️|🛡️)+/u, '').trim();
    return /^ZORP Guide$/i.test(title);
}

function isFixedCloudyEmbed(embed) {`);
replace('        isCloudyWelcomeEmbed(embed)\n', '        isZorpGuideTitle(embed?.title)\n        || isCloudyWelcomeEmbed(embed)\n');
replace('    return names.some(title =>\n', '    if ([record?.title, record?.name].some(isZorpGuideTitle)) return true;\n    return names.some(title =>\n');
fs.writeFileSync(path, source);
console.log('[ZORP_BUILDER] Existing complete guide is available for manual editing; automatic rewrite protection retained.');
