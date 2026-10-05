import fs from 'node:fs';

const path = 'src/events/fullResponseCatalogReady.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function requireReplace(before, after, label) {
  if (text.includes(after)) return;
  if (!text.includes(before)) {
    throw new Error(`[TICKET_LOG_COLOR_GUARD] Missing ${label}`);
  }
  text = text.replace(before, after);
}

if (!text.includes("import { getGuildConfig } from '../services/config/guildConfig.js';")) {
  requireReplace(
    "import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';\n",
    "import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';\nimport { getGuildConfig } from '../services/config/guildConfig.js';\n",
    'guild config import',
  );
}

if (!text.includes('async function isTicketLifecycleLogChannel(message)')) {
  const marker = 'function canonicalComponentCommand(customId = \'\') {';
  const helper = `async function isTicketLifecycleLogChannel(message) {
  if (!message?.guildId || !message?.channelId) return false;
  const config = await getGuildConfig(message.client, message.guildId).catch(() => null);
  return Boolean(
    config
    && (
      String(message.channelId) === String(config.ticketLogsChannelId || '')
      || String(message.channelId) === String(config.ticketTranscriptChannelId || '')
    )
  );
}

`;
  requireReplace(marker, helper + marker, 'ticket lifecycle helper');
}

{
  const start = text.indexOf('async function applyTemplatesToExistingMessage');
  const end = text.indexOf('\n}\n\nfunction seedKnownGameResponses', start);
  if (start < 0 || end < 0) throw new Error('[TICKET_LOG_COLOR_GUARD] applyTemplates block missing');
  let block = text.slice(start, end);
  if (!block.includes('isTicketLifecycleLogChannel(message)')) {
    const anchor = "  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;\n";
    if (!block.includes(anchor)) throw new Error('[TICKET_LOG_COLOR_GUARD] applyTemplates guard anchor missing');
    block = block.replace(
      anchor,
      anchor + "  if (await isTicketLifecycleLogChannel(message)) return false;\n",
    );
    text = text.slice(0, start) + block + text.slice(end);
  }
}

{
  const start = text.indexOf('async function scanRecentBotResponses');
  const end = text.indexOf('\nexport default', start);
  if (start < 0 || end < 0) throw new Error('[TICKET_LOG_COLOR_GUARD] history scan block missing');
  let block = text.slice(start, end);
  if (!block.includes('if (await isTicketLifecycleLogChannel(message)) continue;')) {
    const anchor = '        try {\n';
    const applyIndex = block.indexOf('await applySavedEmbedTemplates(message)');
    const tryIndex = block.lastIndexOf(anchor, applyIndex);
    if (applyIndex < 0 || tryIndex < 0) throw new Error('[TICKET_LOG_COLOR_GUARD] history replay anchor missing');
    const insertAt = tryIndex + anchor.length;
    block = block.slice(0, insertAt)
      + "          if (await isTicketLifecycleLogChannel(message)) continue;\n"
      + block.slice(insertAt);
    text = text.slice(0, start) + block + text.slice(end);
  }
}

requireReplace(
  '    client.on(Events.MessageCreate, message => {',
  '    client.on(Events.MessageCreate, async message => {',
  'async MessageCreate listener',
);

{
  const start = text.indexOf('client.on(Events.MessageCreate');
  const end = text.indexOf('client.on(Events.MessageUpdate', start);
  if (start < 0 || end < 0) throw new Error('[TICKET_LOG_COLOR_GUARD] MessageCreate block missing');
  let block = text.slice(start, end);
  if (!block.includes('if (await isTicketLifecycleLogChannel(message)) return;')) {
    const anchor = '      try {\n';
    if (!block.includes(anchor)) throw new Error('[TICKET_LOG_COLOR_GUARD] MessageCreate try anchor missing');
    block = block.replace(anchor, anchor + '        if (await isTicketLifecycleLogChannel(message)) return;\n');
    text = text.slice(0, start) + block + text.slice(end);
  }
}

{
  const start = text.indexOf('client.on(Events.MessageUpdate');
  const end = text.indexOf('    const timer = setTimeout', start);
  if (start < 0 || end < 0) throw new Error('[TICKET_LOG_COLOR_GUARD] MessageUpdate block missing');
  let block = text.slice(start, end);
  if (!block.includes('if (await isTicketLifecycleLogChannel(message)) return;')) {
    const anchor = '      try {\n';
    if (!block.includes(anchor)) throw new Error('[TICKET_LOG_COLOR_GUARD] MessageUpdate try anchor missing');
    block = block.replace(anchor, anchor + '        if (await isTicketLifecycleLogChannel(message)) return;\n');
    text = text.slice(0, start) + block + text.slice(end);
  }
}

fs.writeFileSync(path, text);
console.log('[TICKET_LOG_COLOR_GUARD] Ticket lifecycle logs isolated from generic response restyling.');
