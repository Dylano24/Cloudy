const PLAYER_COMMAND_NAMES = [
  // Core member commands
  'help',
  'ping',
  'stats',
  'uptime',
  'support',

  // Community / verification
  'apply',
  'verify',

  // Leveling
  'rank',
  'leaderboard',

  // Economy
  'balance',
  'beg',
  'buy',
  'crime',
  'daily',
  'deposit',
  'eleaderboard',
  'fish',
  'gamble',
  'inventory',
  'mine',
  'pay',
  'rob',
  'shop',
  'slut',
  'withdraw',
  'work',

  // Fun
  'count',
  'fight',
  'flip',
  'roll',

  // Music
  'join',
  'music',
  'nowplaying',
  'play',
  'queue',

  // Search / tools / utility
  'search',
  'baseconvert',
  'calculate',
  'countdown',
  'hexcolor',
  'poll',
  'randomuser',
  'shorten',
  'time',
  'unixtime',
  'avatar',
  'todo',
  'weather',

  // Member reporting
  'report',
  'reports',
];

export const PLAYER_COMMANDS = new Set(PLAYER_COMMAND_NAMES);

export function isPlayerCommand(commandName) {
  return PLAYER_COMMANDS.has(String(commandName || '').toLowerCase());
}
