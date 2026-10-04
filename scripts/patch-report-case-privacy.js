import fs from 'node:fs';

function protect(path, signatures) {
  let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  text = "import { isPrivateReportCasePayload } from '../utils/reportCasePrivacy.js';\n" + text;
  for (const [signature, argument, result] of signatures) {
    if (!text.includes(signature)) throw new Error(`Report privacy anchor missing: ${signature}`);
    text = text.replace(signature, `${signature}\n  if (isPrivateReportCasePayload(${argument})) return ${result};`);
  }
  fs.writeFileSync(path, text);
}

protect('src/events/fullResponseCatalogReady.js', [
  ['function applyPayloadTemplates(payload, source) {', 'payload', 'payload'],
  ['function capturePayload(payload, source) {', 'payload', 'false'],
  ['async function applyTemplatesToExistingMessage(message, { initialCreation = false } = {}) {', 'message', 'false'],
  ['export async function applySavedResponsePayloadTemplates(payload, source) {', 'payload', 'payload'],
]);
protect('src/services/embedTemplateService.js', [
  ['export async function applySavedEmbedTemplates(message, { initialCreation = false } = {}) {', 'message', 'false'],
]);
