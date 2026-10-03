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

// Completed historical scans must not prevent the verified existing guide
// from being registered when the owner opens the Builder. This reads/registers
// the original message; it never edits its content.
const managerPath = 'src/services/embedManagerService.js';
let manager = fs.readFileSync(managerPath, 'utf8').replaceAll('\r\n', '\n');
const before = `export async function getCanonicalBuilderRecords(guild, suppliedRecords = null) {
    const records = suppliedRecords || await getEmbedRegistry(guild.id);`;
const after = `export async function getCanonicalBuilderRecords(guild, suppliedRecords = null) {
    let records = suppliedRecords || await getEmbedRegistry(guild.id);
    if (String(guild.id) === '1532882647838228723'
        && !records.some(record => String(record.messageId) === '1554543233047199787')) {
        const channel = guild.channels.cache.get('1554538634898710654');
        const guide = await channel?.messages?.fetch?.('1554543233047199787').catch(() => null);
        if (guide?.author?.id === guild.client.user.id) {
            await registerCloudyEmbedMessage(guide);
            const registered = await getEmbedRegistry(guild.id);
            records = [...records, ...registered.filter(record => String(record.messageId) === '1554543233047199787')];
        }
    }`;
if (!manager.includes(after)) {
  if (!manager.includes(before)) throw new Error('ZORP canonical Builder anchor missing');
  fs.writeFileSync(managerPath, manager.replace(before, after));
}
