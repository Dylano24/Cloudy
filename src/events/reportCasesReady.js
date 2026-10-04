import { Events } from 'discord.js';
import { restoreReportCaseTimers } from '../services/reportCaseService.js';
export default { name: Events.ClientReady, once: true, execute: restoreReportCaseTimers };
