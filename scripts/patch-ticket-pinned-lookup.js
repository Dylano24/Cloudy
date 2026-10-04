import fs from 'node:fs';

const path = 'src/services/ticketUiService.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const before = text;

function replaceRequired(source, previous, next, label) {
  if (source.includes(next)) return source;
  if (!source.includes(previous)) {
    throw new Error(`[TICKET_PINS] Could not find ${label}; refusing an unknown source shape.`);
  }
  return source.replace(previous, next);
}

text = replaceRequired(text,
  "import { logger } from '../utils/logger.js';",
  "import { logger } from '../utils/logger.js';\nimport { getPinnedMessages } from '../utils/messagePins.js';",
  'ticket pin result helper import');
text = replaceRequired(text,
  'const pinnedTicket = pinnedResponse?.items?.find(message => isMainTicketMessage(message, channel));',
  'const pinnedTicket = getPinnedMessages(pinnedResponse).find(message => isMainTicketMessage(message, channel));',
  'ticket pinned message lookup');

if (text !== before) fs.writeFileSync(path, text);
console.log(`[TICKET_PINS] ${path}: ${text === before ? 'already current' : 'patched'}`);
