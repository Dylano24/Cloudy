import fs from 'node:fs';

function patchFile(path, replacements, marker) {
  const before = fs.readFileSync(path, 'utf8');
  let text = before;

  if (text.includes(marker)) {
    console.log(`[TICKET_MAIN_BUILDER] ${path}: already current`);
    return;
  }

  for (const { find, replace, label } of replacements) {
    if (!text.includes(find)) {
      console.error(`[TICKET_MAIN_BUILDER] ${path}: marker not found (${label})`);
      process.exit(1);
    }
    text = text.replace(find, replace);
  }

  if (!text.includes(marker)) {
    console.error(`[TICKET_MAIN_BUILDER] ${path}: final marker missing`);
    process.exit(1);
  }

  fs.writeFileSync(path, text, 'utf8');
  console.log(`[TICKET_MAIN_BUILDER] ${path}: patched`);
}

patchFile('src/services/systemEmbedCatalogService.js', [
  {
    label: 'ticket main catalog definition',
    find: "// Deliberate Builder masters, never captured runtime ticket messages. Their\n",
    replace: "const TICKET_MAIN_CATALOG_TEMPLATE = {\n  key: 'ticket-main',\n  context: 'tickets/main',\n  kind: 'embed',\n  title: 'Ticket #{dynamic}',\n  description: [\n    '{dynamic}, we’ve received your request!',\n    '',\n    'To help us process your ticket as quickly as possible, please provide any additional details you believe may be useful, along with any screenshots or files that could help us better understand your situation.',\n    '',\n    '**Please do not tag or spam our staff members for updates.** We can see your messages and have received all the information you’ve provided. If you don’t receive an immediate response, it simply means that we may be busy elsewhere or handling other requests.',\n    '',\n    'Please be patient and allow us some time to review your ticket and get back to you.',\n    '',\n    'We appreciate your understanding!',\n    '',\n    '**Reason:** {dynamic}',\n  ].join('\\n'),\n  color: 0xFFFFFF,\n  footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },\n};\n\n// Deliberate Builder masters, never captured runtime ticket messages. Their\n",
  },
  {
    label: 'ticket main helper',
    find: "function isTicketContext(context) {\n  return /^tickets(?:\\/|$)/.test(normalize(context));\n}\n",
    replace: "function isTicketContext(context) {\n  return /^tickets(?:\\/|$)/.test(normalize(context));\n}\n\nfunction isTicketMainTemplate(key, context) {\n  return normalize(key) === 'ticket-main' && normalize(context) === 'tickets/main';\n}\n",
  },
  {
    label: 'allow only curated main ticket template',
    find: "  if (!normalizedKey || isTicketContext(normalizedContext)) return false;\n  if (!normalizedKey.startsWith('game:')) return true;",
    replace: "  if (!normalizedKey || (isTicketContext(normalizedContext) && !isTicketMainTemplate(normalizedKey, normalizedContext))) return false;\n  if (isTicketMainTemplate(normalizedKey, normalizedContext)) return true;\n  if (!normalizedKey.startsWith('game:')) return true;",
  },
  {
    label: 'preserve curated ticket main catalog entry',
    find: "      if (isTicketContext(metadata.context)) {\n        markRemoval(message, index);\n        continue;\n      }",
    replace: "      if (isTicketContext(metadata.context) && !isTicketMainTemplate(metadata.key, metadata.context)) {\n        markRemoval(message, index);\n        continue;\n      }",
  },
  {
    label: 'add ticket main to durable catalog',
    find: "    const entries = [\n      ...DEFAULT_TEMPLATES.map(definitionToCatalog),\n      ...TICKET_LOG_CATALOG_TEMPLATES.map(definitionToCatalog),",
    replace: "    const entries = [\n      ...DEFAULT_TEMPLATES.map(definitionToCatalog),\n      definitionToCatalog(TICKET_MAIN_CATALOG_TEMPLATE),\n      ...TICKET_LOG_CATALOG_TEMPLATES.map(definitionToCatalog),",
  },
  {
    label: 'ticket main runtime renderer',
    find: "export function applySystemEmbedTemplate(embed) {\n",
    replace: "function renderTicketMainDynamic(templateValue, values = []) {\n  let index = 0;\n  return String(templateValue || '').replace(/\\{dynamic\\}/gi, () => String(values[index++] ?? ''));\n}\n\nexport function applyTicketMainTemplateData(embedData, { ticketNumber = 'Unknown', userId = null, reason = 'No reason provided' } = {}) {\n  const data = cloneData(embedData);\n  const template = findTemplate('ticket-main', 'tickets/main');\n  if (!template) return data;\n\n  const next = { ...data };\n\n  if (template.title) {\n    next.title = renderTicketMainDynamic(template.title, [ticketNumber]).slice(0, 256);\n  } else {\n    delete next.title;\n  }\n\n  if (template.description) {\n    next.description = renderTicketMainDynamic(\n      template.description,\n      [userId ? `<@${userId}>` : 'A member', reason],\n    ).slice(0, 4096);\n  } else {\n    delete next.description;\n  }\n\n  if (Number.isInteger(template.color)) next.color = template.color;\n  if (template.footer?.text) next.footer = { ...template.footer };\n  else delete next.footer;\n  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };\n  else delete next.thumbnail;\n  if (template.image?.url) next.image = { ...template.image };\n  else delete next.image;\n\n  return next;\n}\n\nexport function applySystemEmbedTemplate(embed) {\n",
  },
], 'applyTicketMainTemplateData(embedData');

patchFile('src/services/ticketV2LayoutService.js', [
  {
    label: 'ticket main template import',
    find: "import { CLOUDY_TICKET_FOOTER } from '../utils/ticket/ticketBranding.js';\n",
    replace: "import { CLOUDY_TICKET_FOOTER } from '../utils/ticket/ticketBranding.js';\nimport { applyTicketMainTemplateData } from './systemEmbedCatalogService.js';\n",
  },
  {
    label: 'apply ticket main builder template',
    find: "function buildTicketEmbed(ticketData, number) {\n  const reason = String(ticketData.reason || 'No reason provided').slice(0, 1024);\n\n  return new EmbedBuilder()\n    .setColor(0xFFFFFF)\n    .setTitle(`Ticket #${number}`)\n    .setDescription(\n      `<@${ticketData.userId}>, ${RECEIVED_INTRO}`\n      + `\\n\\n${RECEIVED_DETAILS}`\n      + `\\n\\n${STAFF_NOTICE}`\n      + `\\n\\n${PATIENCE_NOTICE}`\n      + `\\n\\n${UNDERSTANDING_NOTICE}`\n      + `\\n\\n**Reason:** ${reason}`,\n    )\n    .setFooter({ text: CLOUDY_TICKET_FOOTER });\n}\n",
    replace: "function buildTicketEmbed(ticketData, number) {\n  const reason = String(ticketData.reason || 'No reason provided').slice(0, 1024);\n\n  const baseEmbed = new EmbedBuilder()\n    .setColor(0xFFFFFF)\n    .setTitle(`Ticket #${number}`)\n    .setDescription(\n      `<@${ticketData.userId}>, ${RECEIVED_INTRO}`\n      + `\\n\\n${RECEIVED_DETAILS}`\n      + `\\n\\n${STAFF_NOTICE}`\n      + `\\n\\n${PATIENCE_NOTICE}`\n      + `\\n\\n${UNDERSTANDING_NOTICE}`\n      + `\\n\\n**Reason:** ${reason}`,\n    )\n    .setFooter({ text: CLOUDY_TICKET_FOOTER });\n\n  return new EmbedBuilder(applyTicketMainTemplateData(baseEmbed.toJSON(), {\n    ticketNumber: number,\n    userId: ticketData.userId,\n    reason,\n  }));\n}\n",
  },
], 'applyTicketMainTemplateData(baseEmbed.toJSON()');

patchFile('src/services/embedManagerService.js', [
  {
    label: 'friendly Ticket template label',
    find: "        const name = standardDynamicTemplateName(rawName) || 'Untitled embed';\n        const key = `template:${templateIdentity(channelId, recordEmbedData(record))}`;",
    replace: "        const recordData = recordEmbedData(record);\n        const stableKey = stableSystemTemplateKey(recordData);\n        const name = stableKey === 'ticket-main'\n            ? 'Ticket'\n            : (standardDynamicTemplateName(rawName) || 'Untitled embed');\n        const key = `template:${templateIdentity(channelId, recordData)}`;",
  },
  {
    label: 'refresh active tickets after Ticket template save',
    find: "        if (target.source === 'system-catalog') {\n            // Keep the catalog cache in sync in the same tick as Save. Gateway\n            // MessageUpdate events arrive later and previously caused a race\n            // where the first new game used the old blue template.\n            primeSystemEmbedCatalogMessage(edited);\n            void syncSystemEmbedCatalogMessage(edited)\n                .catch(error => logger.error('Failed to sync saved system embed template:', error));\n        }\n",
    replace: "        if (target.source === 'system-catalog') {\n            // Keep the catalog cache in sync in the same tick as Save. Gateway\n            // MessageUpdate events arrive later and previously caused a race\n            // where the first new game used the old blue template.\n            primeSystemEmbedCatalogMessage(edited);\n            void syncSystemEmbedCatalogMessage(edited)\n                .catch(error => logger.error('Failed to sync saved system embed template:', error));\n        }\n\n        if (String(target.templateTitle || '') === 'ticket-main') {\n            void import('./ticketUiService.js')\n                .then(({ syncCloudyTicketMessage }) => Promise.all(\n                    [...guild.channels.cache.values()]\n                        .filter(channel => /ticket-\\d+/i.test(String(channel?.name || '')) && channel?.messages?.fetch)\n                        .map(channel => syncCloudyTicketMessage(channel)),\n                ))\n                .catch(error => logger.error('Failed to refresh active ticket embeds after template save:', error));\n        }\n",
  },
], "stableKey === 'ticket-main'");

console.log('[TICKET_MAIN_BUILDER] complete');
