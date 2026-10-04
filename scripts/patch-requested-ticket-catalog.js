import fs from 'node:fs';

function edit(path, before, after) {
  const source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`Requested ticket/catalog patch anchor missing: ${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}

edit('src/utils/embeds.js', '  if (!footerText || !isImportantFooter(footerText)) {', '  if (!footerText) {');
edit('src/utils/embeds.js', "import {", "import { withCloudyFooter } from './cloudyFooter.js';\nimport {");
edit('src/utils/embeds.js', '  return templated;\n}', "  templated.data = withCloudyFooter({ embeds: [templated.data] }).embeds[0];\n  return templated;\n}");
edit('src/services/ticket.js', `    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      if (user) {
        await channel.permissionOverwrites.create(user, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
      }
    } catch (error) {
      logger.warn(\`Could not restore access for user \${ticketData.userId}:\`, error.message);
    }`, `    // Restore the creator by ID and await Discord before sending the real ping.
    // A failed member fetch must not silently leave the reopened ticket hidden.
    await channel.permissionOverwrites.edit(ticketData.userId, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    }, { type: 1, reason: 'Restore ticket creator access before reopen notification' });`);
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

// Reopening is a distinct reusable lifecycle; do not classify it as an old ticket artifact.
edit('src/services/embedManagerService.js', '    const titleDefinitions = [', String.raw`    const titleDefinitions = [
        ['reopen', 'Ticket reopened', /\breopen(?:ed)?\b/],`);
edit('src/utils/ticket/ticketLogTemplates.js', "  if (!fields.has('ticket')) return null;", "  if (cleanTitle(data.title) === 'ticket reopened') return { key: 'reopen', label: 'Ticket reopened' };\n  if (!fields.has('ticket')) return null;");
edit('src/services/ticket.js', "import { logTicketEvent }", "import { decorateEmbedWithSavedTemplate } from './embedTemplateService.js';\nimport { logTicketEvent }");
edit('src/services/ticket.js', '    const closeStatusMessage = messages.find(m =>', String.raw`    const reopenConfig = await getGuildConfig(channel.client, channel.guild.id);
    const decoratedReopen = await decorateEmbedWithSavedTemplate(channel.guild.id, reopenConfig.ticketLogsChannelId || channel.id, reopenEmbed);
    const closeStatusMessage = messages.find(m =>`);
edit('src/services/ticket.js', 'embeds: [forceCloudyTicketFooter(reopenEmbed)]', 'embeds: [forceCloudyTicketFooter(decoratedReopen.embed)]');

// Search has one master per type; channel browsing must retain that type in each channel.
edit('src/services/embedManagerService.js', 'export async function getCanonicalBuilderRecords(guild, suppliedRecords = null) {', 'export async function getCanonicalBuilderRecords(guild, suppliedRecords = null, { perChannel = false } = {}) {');
edit('src/services/embedManagerService.js', String.raw`        if (!groups.has(identity)) groups.set(identity, []);
        groups.get(identity).push(record);
    }
    return [...groups.entries()].map(([identity, peers]) => {`, String.raw`        const groupKey = perChannel ? String(record.channelId) + '|' + identity : identity;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(record);
    }
    return [...groups.entries()].map(([groupKey, peers]) => {
        const identity = perChannel ? groupKey.slice(groupKey.indexOf('|') + 1) : groupKey;`);
edit('src/services/embedManagerService.js', 'let records = await getCanonicalBuilderRecords(guild, storedRecords);', 'let records = await getCanonicalBuilderRecords(guild, storedRecords, { perChannel: true });');
edit('src/services/embedManagerService.js', '                    records = await getCanonicalBuilderRecords(guild);', String.raw`                    const discoveredRecords = await discoverRecentChannelEmbeds(guild, channelId, buttonInteraction.client.user.id)
                        .catch(error => { logger.debug('Channel embed discovery skipped: ' + error.message); return []; });
                    const registeredRecords = await getEmbedRegistry(guild.id);
                    records = await getCanonicalBuilderRecords(guild, mergeEmbedManagerRecords(registeredRecords, discoveredRecords), { perChannel: true });`);


