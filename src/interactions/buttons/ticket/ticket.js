import { priorityTicketHandler } from '../../../handlers/ticketButtons.js';

// Legacy ticket_priority buttons are kept for older ticket messages.
// All current ticket controls are handled by ticketUiOverrides.js.
export default [priorityTicketHandler];
