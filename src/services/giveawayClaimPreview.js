// Shared giveaway claim preview for the builder and private winner channel.
// The displayed code is a NON-REDEEMABLE DEMO, not an activation credential.
import { createHash, randomBytes } from 'node:crypto';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { DEFAULT_CLAIM_ICONS } from './giveawayClaimIcons.js';

export const DEFAULT_CLAIM_HEADING = 'Congratulations on winning!';
export const DEFAULT_CLAIM_IMPORTANT =
  'This private channel will be automatically deleted **24 hours** after your code is revealed. ' +
  'Make sure to copy or screenshot your code before then.';

export function createDemoClaimCode() {
  const hex = randomBytes(4).toString('hex').toUpperCase();
  return 'DEMO-' + hex.slice(0, 4) + '-' + hex.slice(4);
}

export function normalizeDemoClaimCode(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 31);
  if (!cleaned) return '';
  return cleaned.startsWith('DEMO-') ? cleaned : 'DEMO-' + cleaned.replace(/^DEMO-?/, '');
}

// Older posted giveaways predate draft demo codes. Use a stable demo-only value
// so editing or refreshing their claim panel never generates a different code.
export function displayDemoClaimCode(giveaway, userId) {
  const stored = normalizeDemoClaimCode(giveaway?.claimDemoCode);
  if (stored) return stored;
  const digest = createHash('sha256').update(
    String(giveaway?.guildId || '') + ':' + String(giveaway?.messageId || 'preview') + ':' + String(userId || ''),
  ).digest('hex').toUpperCase();
  return 'DEMO-' + digest.slice(0, 4) + '-' + digest.slice(4, 8);
}

export function buildPrivateClaimEmbed(giveaway, userId, icons = DEFAULT_CLAIM_ICONS) {
  const title = giveaway?.claimPanelTitle?.trim();
  const heading = title && !['Congratulations!', 'Your giveaway prize'].includes(title)
    ? title
    : DEFAULT_CLAIM_HEADING;
  const important = giveaway?.claimExpiryInstructions?.trim() || DEFAULT_CLAIM_IMPORTANT;
  const demoCode = displayDemoClaimCode(giveaway, userId);
  return {
    description: '**' + heading + '**\n\n'
      + icons.key + ' **Claim your code here**\n'
      + String.fromCharCode(96) + demoCode + String.fromCharCode(96)
      + '\n\n' + icons.clock + ' **Important**\n'
      + important,
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
}
