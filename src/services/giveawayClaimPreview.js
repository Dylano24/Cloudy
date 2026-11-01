// Private giveaway claim message and Giveaway Builder preview use the same copy.
// Real activation codes are never included in this embed.
import { createHash, randomBytes } from 'node:crypto';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { DEFAULT_CLAIM_ICONS } from './giveawayClaimIcons.js';

export const CLAIM_INTRO_ICON = '<:W90250885giveaway:1543303914152001536>';
export const CLAIM_REVIEW_ICON = '<:W84starwhite:1543289625035022346>';
export const CLAIM_WARNING_ICON = '<:W97warningwhite:1543290138707230730>';
export const CLAIM_HEART_ICON = '<a:W79heart4:1543304318470324324>';
export const CLAIM_PRIZE_ICON = '<:W89gift:1543303758912688230>';
export const STAFF_REVIEWS_CHANNEL_ID = '1554538609330225225';
export const DEFAULT_CLAIM_PRIZE_NOTICE = 'Please review the information below before collecting it.';

export const DEFAULT_CLAIM_INTRODUCTION =
  'Cloudy Inc. congratulates you on winning this prize!';
export const DEFAULT_CLAIM_CONDITIONS = 'Details and conditions of their prize.';
export const DEFAULT_CLAIM_HOW_TO_GET =
  'Click the **Reveal my code** button below to display your activation code.';
export const DEFAULT_CLAIM_REVIEW =
  "If you enjoyed your prize and are satisfied with your experience and the work of our team, we’d appreciate it if you could take a moment to leave us a rating in our staff reviews section.\n\n"
  + "Your feedback means a lot to us. It encourages our team, helps us improve and supports what we do at Cloudy Inc."
  + CLAIM_HEART_ICON;
export const DEFAULT_CLAIM_PLEASE_NOTE =
  'This private channel will be automatically deleted after 24 hours. Make sure to copy or take a screenshot of your activation code before the channel is deleted.\n\n'
  + 'You can also close this channel yourself using the **Close** button below.';

// Kept for existing test giveaways and staff-owned private code configuration.
// Demo-prefixed values are never valid redemption credentials.
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

function linkifyStaffReviews(body, guildId) {
  if (!guildId) return body;
  const url = 'https://discord.com/channels/' + guildId + '/' + STAFF_REVIEWS_CHANNEL_ID;
  // Convert default or bold wording without nesting existing Markdown links.
  return body.replace(/(?<!\[)\*\*staff reviews\*\*(?!\])/gi, '[staff reviews](' + url + ')')
    .replace(/(?<!\[)\bstaff reviews\b(?!\])/gi, '[staff reviews](' + url + ')');
}

// Existing custom Edit claim content may still contain a tiny saved space
// from an older default. Eliminate it immediately before the animated heart.
function tightenHeartGap(body) {
  return body.replace(/(Cloudy Inc\.)[ \t\u00A0\u2009\u200A\u202F\u200B]+(?=<a:W79heart4:1543304318470324324>)/g, '$1');
}

export function buildPrivateClaimEmbed(giveaway, _userId, icons = DEFAULT_CLAIM_ICONS) {
  const text = (name, fallback) => giveaway?.[name]?.trim() || fallback;
  return {
    description: CLAIM_INTRO_ICON + ' ' + text('claimIntroduction', DEFAULT_CLAIM_INTRODUCTION)
      + '\n\n' + CLAIM_PRIZE_ICON + ' **' + String(giveaway?.prize || 'Your prize').replaceAll('*', '') + '**'
      + '\n\n' + DEFAULT_CLAIM_PRIZE_NOTICE
      + '\n\n' + icons.info + ' **Prize conditions**\n'
      + text('claimConditions', DEFAULT_CLAIM_CONDITIONS)
      + '\n\n' + icons.key + ' **How to get your prize**\n'
      + text('claimHowToGet', DEFAULT_CLAIM_HOW_TO_GET)
      + '\n\n' + CLAIM_REVIEW_ICON + ' **Share your feedback**\n'
      + linkifyStaffReviews(tightenHeartGap(text('claimReview', DEFAULT_CLAIM_REVIEW)), giveaway?.guildId)
      + '\n\n\n' + CLAIM_WARNING_ICON + ' \u2009\u200A\u200A\u200A**Please note**\n'
      + text('claimPleaseNote', DEFAULT_CLAIM_PLEASE_NOTE),
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
}
