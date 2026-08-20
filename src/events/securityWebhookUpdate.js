import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.WebhooksUpdate,
  once: false,
  async execute(channel) {
    const guild = channel.guild;
    if (!guild) return;

    const checks = [
      [AuditLogEvent.WebhookCreate, 'webhook-create'],
      [AuditLogEvent.WebhookDelete, 'webhook-delete'],
      [AuditLogEvent.WebhookUpdate, 'webhook-update'],
    ];

    for (const [auditType, actionType] of checks) {
      try {
        await processAntiNukeAuditEvent(guild, {
          auditType,
          actionType,
          targetLabel: `Webhook in #${channel.name}`,
          delayMs: actionType === 'webhook-create' ? 800 : 0,
        });
      } catch (error) {
        logger.warn(`Anti-nuke ${actionType} monitor failed: ${error?.message || error}`);
      }
    }
  },
};
