import fs from 'node:fs';

const path = 'src/utils/interactionMessageLifecycle.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

if (!text.includes("import { getResponseLifetime } from './responseLifetime.js';")) {
  const anchor = "import { isBuilderSessionMessage } from './builderSessionCleanup.js';\n";
  if (!text.includes(anchor)) throw new Error('[TICKET_PRIVATE_10S] response lifetime import anchor missing');
  text = text.replace(anchor, anchor + "import { getResponseLifetime } from './responseLifetime.js';\n");
}

if (!text.includes('export function shouldUseTicketPrivateTransientTimer(')) {
  const transientStart = text.indexOf('export function shouldUseTransientTimer(payload, message) {');
  const nextFunction = text.indexOf('\nfunction scheduleDashboardIfNeeded', transientStart);
  if (transientStart < 0 || nextFunction < 0) {
    throw new Error('[TICKET_PRIVATE_10S] transient timer runtime block missing');
  }

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
  // createTicketUi marks successful creation with an explicit null lifetime;
  // its cleanup belongs exclusively to the ticket-delete lifecycle.
  if (getResponseLifetime(interaction) === null) return false;

  return true;
}
`;

  text = text.slice(0, nextFunction) + '\n' + addition + text.slice(nextFunction);
}

if (!text.includes('shouldUseTicketPrivateTransientTimer(interaction, payload, message)')) {
  throw new Error('[TICKET_PRIVATE_10S] private ticket timer helper was not installed');
}

const scheduleNeedle = 'if (shouldUseTransientTimer(payload, message)) {';
if (text.includes(scheduleNeedle)) {
  text = text.replace(
    scheduleNeedle,
    `if (
          shouldUseTransientTimer(payload, message)
          || shouldUseTicketPrivateTransientTimer(interaction, payload, message)
        ) {`,
  );
} else if (!text.includes('|| shouldUseTicketPrivateTransientTimer(interaction, payload, message)')) {
  throw new Error('[TICKET_PRIVATE_10S] lifecycle scheduling anchor missing');
}

fs.writeFileSync(path, text);
console.log('[TICKET_PRIVATE_10S] Private ticket status replies expire after 10s; Ticket created stays until ticket deletion.');
