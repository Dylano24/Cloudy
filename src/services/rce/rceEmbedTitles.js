// Titles of the Rust Console module's feed posts, boards and command answers.
// Their layout and colours are fixed in rceEmbeds.js and the /rce, /rceconfig
// and /rust commands, so — like the game feeds — saved or auto-learned
// response templates never restyle them, and busy feeds (a post per kill or
// chat line) are not captured into the response catalog.
// No imports: gameFeedTitles.js (used by the template layers) loads this.
const TITLES = new Set([
  // feeds
  'kill feed', 'login', 'logout', 'zorp', 'local chat', 'team chat', 'server chat', 'global chat', 'chat',
  'airdrop', 'cargo ship', 'chinook', 'patrol helicopter', 'halloween', 'christmas', 'easter',
  'kit given', 'item given', 'player banned', 'player unbanned', 'role added', 'role removed',
  'server connected', 'server disconnected', 'account linked', 'emote action', 'console command',
  'shop purchase', 'shop delivery to check', 'store delivery received', 'store delivery with problems', 'store item delivered',
  'server status',
  // command answers
  'rust servers', 'server added', 'rust feed channels', 'rust settings', 'rust settings updated', 'rust shop',
  'emote actions', 'teleport locations', 'automatic messages', 'zorp updated', 'rust access', 'linked members',
  'store deliveries', 'rust profile', 'online players', 'bounties', 'link your account', 'your zorp zone', 'delivery sent',
  'kills leaderboard', 'k/d leaderboard', 'playtime leaderboard', 'best killstreak leaderboard', 'npc kills leaderboard',
]);
const PREFIXES = ['console · ', 'online · ', 'stats · ', 'zorp zones · ', 'staff: '];

export function rceTitleKey(title) {
  return String(title || '').replace(/<a?:\w+:\d+>/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
}

export function isRceEmbed(data) {
  if (!String(data?.footer?.text || '').startsWith('© Cloudy Inc.')) return false;
  const title = rceTitleKey(data?.title);
  return TITLES.has(title) || PREFIXES.some(prefix => title.startsWith(prefix));
}
