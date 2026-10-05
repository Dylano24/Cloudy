import fs from 'node:fs';

const path = 'src/utils/interactionMessageLifecycle.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

if (!text.includes("import { getResponseLifetime } from './responseLifetime.js';")) {
  const anchor = "import { isBuilderSessionMessage } from './builderSessionCleanup.js';\n";
  if (!text.includes(anchor)) throw new Error('[TICKET_PRIVATE_10S] response lifetime import anchor missing');
  text = text.replace(anchor, anchor + "import { getResponseLifetime } from './responseLifetime.js';\n");
}

if (!text.includes('export function shouldUseTicketPrivateTransientTimer(')) {
  const anchor = `export function shouldUseTransientTimer(payload, message) {
  // The Message Builder renders the selected embed as its first embed. Titles
  // such as Success, Warning, Information or Could not... are valid preview
  // content and must never make the whole Builder look like a 10-second status
  // reply. Builder lifetime is owned exclusively by builderSessionCleanup.
  if (isBuilderSessionMessage(message)) return false;
  return isTransientStatusPayload(payload, message);
}
`;

  if (!text.includes(anchor)) throw new Error('[TICKET_PRIVATE_10S] transient timer function anchor missing');

  const addition = `
function isTicketInteraction(interaction) {
  const customId = String(interaction?.customId || '').toLowerCase();
  const commandName = String(interaction?.commandName || '').toLowerCase();
  return customId.includes('ticket') || commandName === 'ticket';
}

function ticketReplyComponents(payload, message) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return source.components || message?.components || [];
}

export function shouldUseTicketPrivateTransientTimer(interaction, payload, message) {
  if (!isTicketInteraction(interaction)) return false;
  if (!isEphemeralLifecycleMessage(payload, message)) return false;
  if (isBuilderSessionMessage(message)) return false;
  if (isDashboardSessionPayload(payload, message)) return false;
  if (ticketReplyComponents(payload, message).length) return false;

  // Ticket created is the one deliberate persistent private confirmation.
  // createTicketUi marks that successful response with an explicit null lifetime
  // so its cleanup belongs to the ticket-delete lifecycle instead.
  if (getResponseLifetime(interaction) === null) return false;

  return true;
}
`;

  text = text.replace(anchor, anchor + addition);
}

const oldSchedule = `        if (shouldUseTransientTimer(payload, message)) {
          schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);
        }`;
const newSchedule = `        if (
          shouldUseTransientTimer(payload, message)
          || shouldUseTicketPrivateTransientTimer(interaction, payload, message)
        ) {
          schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);
        }`;

if (text.includes(oldSchedule)) {
  text = text.replace(oldSchedule, newSchedule);
} else if (!text.includes('shouldUseTicketPrivateTransientTimer(interaction, payload, message)')) {
  throw new Error('[TICKET_PRIVATE_10S] lifecycle scheduling anchor missing');
}

fs.writeFileSync(path, text);
console.log('[TICKET_PRIVATE_10S] Private ticket status replies expire after 10s; Ticket created stays until ticket deletion.');
