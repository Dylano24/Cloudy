import fs from 'node:fs';

function edit(path, before, after) {
  const source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`Requested ticket/catalog patch anchor missing: ${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}

edit('src/utils/embeds.js', '  if (!footerText || !isImportantFooter(footerText)) {', '  if (!footerText) {');
edit('src/utils/embeds.js', "import {", "import { withCloudyFooter } from './cloudyFooter.js';\nimport {");
edit('src/utils/embeds.js', '  return templated;\n}', "  templated.data = withCloudyFooter({ embeds: [templated.data] }).embeds[0];\n  return templated;\n}");
edit('src/services/ticket.js', `    if (closeStatusMessage) {
      await closeStatusMessage.edit({ embeds: [reopenEmbed], components: [] });
    } else {
      await channel.send({ embeds: [reopenEmbed] });
    }`, `    if (closeStatusMessage) await closeStatusMessage.edit({ components: [] });
    await channel.send({ content: \`<@\${ticketData.userId}>\`, embeds: [forceCloudyTicketFooter(reopenEmbed)],
      allowedMentions: { parse: [], users: [ticketData.userId] } });`);
// Keep lifecycle notices and other feature responses in durable catalog masters.
edit('src/services/systemEmbedCatalogService.js', 'export const TICKET_LOG_CATALOG_TEMPLATES = [', `export const TICKET_LOG_CATALOG_TEMPLATES = [
  { key: 'ticket-log:reopen', context: 'ticket-logs/reopen', title: 'Ticket reopened', description: '{dynamic} has reopened this ticket!', color: CLOUDY_GREEN_COLOR, footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } },`);
edit('src/services/systemEmbedCatalogService.js', '  const definitions = discoveredDefinitions.filter(definition =>', `  for (const definition of discoveredDefinitions) {
    if (definition.kind === 'embed') {
      const previous = definition.footer?.text;
      if (previous && /\\b(close|closes|closed|expire|expires|available in|page\\s+\\d+|dashboard closes|ticket id)\\b/i.test(previous)) definition.fields = [...(definition.fields || []), { name: 'Information', value: previous, inline: false }];
      definition.footer = { text: '© Cloudy Inc. • Quality. Innovation. Performance.' };
    }
  }
  const definitions = discoveredDefinitions.filter(definition =>`);
// Preserve the new public report logs even when the Builder gives them a saved
// status-like title. Their channel or control IDs keep them out of generic TTLs.
edit('src/utils/transientResponse.js', 'export function isPersistentBotMessage(message) {', `export function isPersistentBotMessage(message) {
  if (/^report-\\d+$/.test(String(message?.channel?.name || ''))) return true;
  if ((message?.components || []).some(row => (row.components || []).some(button => /^report_case:/.test(button.customId || button.custom_id || '')))) return true;`);
console.log('[PATCH] Requested ticket mentions, catalog footers and report lifetime exclusions applied.');
