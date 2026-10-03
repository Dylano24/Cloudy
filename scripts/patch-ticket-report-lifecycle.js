import fs from 'node:fs';

function edit(path, before, after) {
  const text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Ticket/report patch anchor missing: ${path}`);
  fs.writeFileSync(path, text.replace(before, after));
}

edit('src/utils/interactionMessageLifecycle.js',
  "import { Message, MessageFlags } from 'discord.js';",
  "import { Message, MessageFlags } from 'discord.js';\nimport { getResponseLifetime } from './responseLifetime.js';");
edit('src/utils/interactionMessageLifecycle.js',
  '        if (shouldUseTransientTimer(payload, message)) {\n          schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);\n        }',
  '        const lifetime = getResponseLifetime(interaction);\n        if (lifetime !== undefined) {\n          clearTimer(transientTimers, message.id);\n          if (lifetime !== null) schedule(transientTimers, message, interaction, lifetime);\n        } else if (shouldUseTransientTimer(payload, message)) {\n          schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);\n        }');

edit('src/services/ticketUiService.js',
  "        title: 'Ticket claimed',\n        description: `${claimerMention} has claimed this ticket.`,\n        color: '#FFFFFF',",
  "        title: 'Ticket claimed',\n        description: `${claimerMention} has claimed this ticket.`,\n        color: '#00C49D',");
edit('src/services/ticketUiService.js',
  "        title: 'Ticket unclaimed',\n        description: `${unclaimerMention} has unclaimed this ticket.`,\n        color: '#FFFFFF',",
  "        title: 'Ticket unclaimed',\n        description: `${unclaimerMention} has unclaimed this ticket.`,\n        color: '#000000',");
edit('src/services/ticket.js', 'const TICKET_DELETE_DELAY_MS = 3000;', 'const TICKET_DELETE_DELAY_MS = 10_000;');
for (const path of ['src/services/ticket.js', 'src/services/ticketUiService.js']) {
  const text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const importLine = "import { requireTicketCloseReason } from './ticketActionPolicy.js';\n";
  if (!text.includes(importLine)) fs.writeFileSync(path, importLine + text);
  edit(path, "export async function closeTicket(channel, closer, reason = 'No reason provided') {",
    'export async function closeTicket(channel, closer, reason) {\n  reason = requireTicketCloseReason(reason);');
}

// The legacy dispatcher remains available for older ticket controls.
edit('src/handlers/ticketButtons.js',
  "import { getTicketPermissionContext } from '../utils/ticket/ticketPermissions.js';",
  "import { getTicketPermissionContext } from '../utils/ticket/ticketPermissions.js';\nimport { requireTicketCloseReason } from '../services/ticketActionPolicy.js';");
edit('src/handlers/ticketButtons.js',
  ".setLabel('Reason for closing (optional)')",
  ".setLabel('Reason for closing')");
edit('src/handlers/ticketButtons.js',
  ".setPlaceholder('Add an optional reason for closing this ticket...')\n        .setRequired(false)",
  ".setPlaceholder('Explain why you are closing this ticket...')\n        .setRequired(true)");
edit('src/handlers/ticketButtons.js',
  "      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();\n      const reason = providedReason || 'Closed via ticket button without a specific reason.';",
  "      const reason = requireTicketCloseReason(interaction.fields.getTextInputValue('reason'));");
edit('src/handlers/ticketButtons.js',
  "      await interaction.editReply({ embeds: [successEmbed('Ticket reopened', reopenMessage)] });",
  "      await interaction.deleteReply().catch(() => {});");
edit('src/handlers/ticketButtons.js',
  "      logger.error('Error reopening ticket:', error);\n      if (!interaction.replied && !interaction.deferred) {",
  "      logger.error('Error reopening ticket:', error);\n      if (error?.type === ErrorTypes.PERMISSION) {\n        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the staff team can reopen tickets.' });\n        return;\n      }\n      if (!interaction.replied && !interaction.deferred) {");
// Keep the old dispatcher on the same public creation/cleanup path.
{
  const path = 'src/handlers/ticketButtons.js';
  let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const importLine = "import ticketModals from '../interactions/modals/ticket/createTicketUi.js';\n";
  if (!text.includes(importLine)) text = importLine + text;
  text = text.replace(/const createTicketModalHandler = \{[\s\S]*?\n\};\n\nconst closeTicketHandler/, "const createTicketModalHandler = ticketModals.find(handler => handler.name === 'create_ticket_modal');\n\nconst closeTicketHandler");
  text = text.replaceAll("'You must have **Manage Channels** or the configured **Ticket Staff Role**.'", "`Only the staff team can ${actionLabel}.`")
    .replaceAll("'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'", "'Only the ticket creator or the staff team can perform this action.'");
  fs.writeFileSync(path, text);
}
console.log('[PATCH] Ticket/report lifetimes, colors and required close reasons applied.');
