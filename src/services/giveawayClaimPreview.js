// Shared minimal claim embed for private winner channels and the builder preview.
// DEMO-prefixed codes are not redeemable and must never be treated as real credentials.
import { createHash, randomBytes } from 'node:crypto';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { DEFAULT_CLAIM_ICONS } from './giveawayClaimIcons.js';

export const DEFAULT_CLAIM_HEADING = 'Congratulations on winning!';
export const DEFAULT_CLAIM_IMPORTANT =
  "Once you've secured your prize, click **Prize taken** to close this channel.\n\n"
  + "This private channel will be automatically deleted after **24 hours**, even if you don't close it manually.";
export const DEFAULT_CLAIM_REVIEW =
  "We'd appreciate your feedback! Click **Rate us** below to share your experience.";
export const PLAYSTATION_PRIZE_DESCRIPTION =
  "You've won a **PlayStation Store gift card!** Redeem your code through the PlayStation Store "
  + "to add the balance to your PlayStation wallet.";

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

export function displayDemoClaimCode(giveaway, userId) {
  const stored = normalizeDemoClaimCode(giveaway?.claimDemoCode);
  if (stored) return stored;
  const digest = createHash('sha256').update(
    String(giveaway?.guildId || '') + ':' + String(giveaway?.messageId || 'preview') + ':' + String(userId || ''),
  ).digest('hex').toUpperCase();
  return 'DEMO-' + digest.slice(0, 4) + '-' + digest.slice(4, 8);
}

function descriptionForPrize(giveaway) {
  if (giveaway?.claimDetails?.trim()) return giveaway.claimDetails.trim();
  const prize = String(giveaway?.prize || '').trim();
  if (!prize || prize === 'Your prize' || /playstation|psn|ps store/i.test(prize)) {
    return PLAYSTATION_PRIZE_DESCRIPTION;
  }
  return "You've won **" + prize.replace(/\*/g, '') + "**! Follow the redemption instructions supplied by Cloudy staff.";
}

export function buildPrivateClaimEmbed(giveaway, userId, icons = DEFAULT_CLAIM_ICONS) {
  const title = giveaway?.claimPanelTitle?.trim();
  const heading = title && !['Congratulations!', 'Your giveaway prize'].includes(title)
    ? title
    : DEFAULT_CLAIM_HEADING;
  const important = giveaway?.claimExpiryInstructions?.trim() || DEFAULT_CLAIM_IMPORTANT;
  return {
    description: '**' + heading + '**\n\n'
      + icons.key + ' **Claim your code here**\n'
      + '||' + displayDemoClaimCode(giveaway, userId) + '||'
      + '\n\n' + icons.info + ' **Prize details**\n'
      + descriptionForPrize(giveaway)
      + '\n\n' + icons.clock + ' **Important**\n'
      + important
      + '\n\n' + (icons.star ? icons.star + ' ' : '') + '**Your review**\n'
      + DEFAULT_CLAIM_REVIEW,
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
}
