import { CLOUDY_ADOPTED_BUILDER_SOURCES } from './builderCatalogOwnership.js';

// Builder admission is an explicit product choice, separate from whether a
// command can execute. Retiring a template never deletes its saved owner edits.
export const RETIRED_BUILDER_COMMAND_FILES = new Set([
  'src/commands/Economy/fish.js', 'src/commands/Economy/mine.js',
  'src/commands/Economy/slots.js', 'src/commands/Economy/gamble.js',
  'src/commands/Fun/count.js', 'src/commands/Fun/fight.js',
  'src/commands/Fun/flip.js', 'src/commands/Fun/roll.js',
  'src/commands/Giveaway/gcreate.js', 'src/commands/Giveaway/gend.js',
  'src/commands/Giveaway/gdelete.js', 'src/commands/Giveaway/greroll.js',
]);

const RETIRED_CONTEXTS = new Set([
  'gambling/fish', 'gambling/mine', 'gambling/slots', 'gambling/fight',
  'gambling/flip', 'gambling/roll', 'gambling/slut', 'gambling/gamble',
  'botlog/count', 'giveaway/gcreate', 'giveaway/gend',
  'giveaway/gdelete', 'giveaway/greroll',
]);

const OPTIONAL_NAMES = new Set([
  'support', 'stats', 'uptime', 'baseconvert', 'calculate', 'countdown',
  'generatepassword', 'hexcolor', 'randomuser', 'shorten', 'time',
  'unixtime', 'weather', 'todo', 'search', 'firstmsg', 'avatar',
  'userinfo', 'serverinfo', 'birthday', 'next-birthdays', 'next_birthdays',
]);

const CLOUDY_CONTEXTS = new Set([
  'embed-builder', 'embed-manager', 'tickets', 'ticket-logs', 'ticket-transcripts',
  'giveaway', 'gambling', 'welcome', 'rules', 'faq', 'reports', 'ban-appeal',
  'staff-reviews', 'shop', 'music', 'verification', 'join-to-create',
]);
const CLOUDY_BOTLOG_NAMES = new Set([
  'botprofile', 'configwizard', 'commands', 'ping', 'logging', 'ban', 'unban',
  'kick', 'timeout', 'untimeout', 'warn', 'warnings', 'cases', 'usernotes',
  'purge', 'lock', 'unlock', 'massban', 'masskick', 'say', 'dm', 'changelog',
  'zorp-guide-service', 'content-creator-guide-service', 'security-information-ready',
  'rust-patch-notes-service', 'nitrado-patch-notes-ready', 'patchbot-service',
  'gamefeed', 'change-log-service', 'incoming-payment-dm-service',
  'cloudy-feed-dashboard-service', 'cloudy-feed-extractor-service',
  'cloudy-feed-parser', 'cloudy-feed-service', 'cloudy-builder-action',
  'cloudy-fix-guide-interaction', 'cloudy-owner-assistant-message-create',
  'cloudy-owner-assistant-ready', 'vote', 'vote-manage-service', 'vote-media',
]);

export function builderCatalogFeature({ context = '', sourcePath = '' } = {}) {
  const scope = String(context).trim().toLowerCase();
  const source = String(sourcePath).replaceAll('\\', '/').replace(/^\.\//, '');
  if (RETIRED_BUILDER_COMMAND_FILES.has(source) || RETIRED_CONTEXTS.has(scope)) {
    return { state: 'retired', approved: false };
  }
  const [family, rawName = ''] = scope.split('/');
  const name = rawName.replace(/\.js$/, '');
  if (/^level(?:[-_]|add$|remove$|set$|$)/.test(name) || name === 'rank') {
    return { state: 'disabled', approved: false };
  }
  if (CLOUDY_ADOPTED_BUILDER_SOURCES.has(source)) return { state: 'active', approved: true };
  if (OPTIONAL_NAMES.has(name) || /^(?:birthday|search)[_-]/.test(name)) {
    return { state: 'active', approved: false };
  }
  if (CLOUDY_CONTEXTS.has(family)
      || (family === 'utility' && ['embedbuilder', 'vote', 'auto'].includes(name))
      || (family === 'botlog' && CLOUDY_BOTLOG_NAMES.has(name))) {
    return { state: 'active', approved: true };
  }
  return { state: 'unknown', approved: false };
}
