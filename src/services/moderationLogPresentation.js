import { EmbedBuilder } from 'discord.js';

export const CLOUDY_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const MODERATION_RESTRICT_COLOR = 0xA9AF00;
export const MODERATION_RESTORE_COLOR = 0x00C49D;

const RESTRICT_TYPES = new Set(['moderation.kick', 'moderation.timeout']);
const RESTORE_TYPES = new Set(['moderation.unban', 'moderation.untimeout']);

export function enforceFixedLogPresentation(embed, { eventType = null, inviteType = null } = {}) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };

  if (RESTRICT_TYPES.has(eventType)) data.color = MODERATION_RESTRICT_COLOR;
  if (RESTORE_TYPES.has(eventType)) data.color = MODERATION_RESTORE_COLOR;
  if (inviteType === 'created') data.color = 0xFFFFFF;
  if (inviteType === 'joined') data.color = MODERATION_RESTORE_COLOR;
  if (inviteType || eventType) data.thumbnail = { url: CLOUDY_LOGO_URL };

  return new EmbedBuilder(data);
}
