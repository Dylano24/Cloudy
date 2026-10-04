import { Events } from 'discord.js';
import { ensureAppealActions } from '../services/appealActionService.js';
export default { name: Events.ClientReady, once: true, execute: ensureAppealActions };
