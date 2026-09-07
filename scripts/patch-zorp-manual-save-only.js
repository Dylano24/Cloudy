import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const target = path.resolve(__dirname, '../src/services/embedTemplateService.js');
let source = fs.readFileSync(target, 'utf8');

const oldStart = `export async function applySavedEmbedTemplates(message) {\n  if (!message?.guildId || !message?.channelId || !message?.editable || !message?.embeds?.length) return false;`;
const newStart = `export async function applySavedEmbedTemplates(message) {\n  if (!message?.guildId || !message?.channelId || !message?.editable || !message?.embeds?.length) return false;\n\n  // ZORP Guide is owner-authored content. Never rewrite it from background\n  // template/catalog/normalization passes. A manual Embed Builder Save still\n  // edits the message and persists its template through the normal save path.\n  const isProtectedZorpGuide = message.embeds.some(embed => /^\\s*(?:☑️\\s*)?ZORP Guide\\s*$/i.test(String(embed?.title || '')));\n  if (isProtectedZorpGuide) return true;`;

if (!source.includes(newStart)) {
  if (!source.includes(oldStart)) {
    console.error('[ZORP_MANUAL_SAVE_ONLY] applySavedEmbedTemplates marker not found');
    process.exit(1);
  }
  source = source.replace(oldStart, newStart);
  fs.writeFileSync(target, source, 'utf8');
}

console.log('[ZORP_MANUAL_SAVE_ONLY] protected ZORP Guide from automatic template rewrites');
