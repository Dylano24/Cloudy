import { PermissionFlagsBits } from 'discord.js';

export function ticketActorPermissions({ member, userId, ownerId, staffRoleId, creatorId }) {
  const staff = Boolean(ownerId && String(userId) === String(ownerId))
    || Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator))
    || Boolean(staffRoleId && member?.roles?.cache?.has?.(staffRoleId));
  const creator = Boolean(creatorId && String(userId) === String(creatorId));
  return { canManageTicket: staff, canCloseTicket: staff || creator, canReopenTicket: staff || creator };
}

export function requireTicketCloseReason(value) {
  const reason = String(value || '').trim();
  if (!reason) {
    throw Object.assign(new Error('Ticket close reason required'), {
      code: 'TICKET_CLOSE_REASON_REQUIRED', userMessage: 'Please provide a reason for closing this ticket.',
    });
  }
  return reason;
}
