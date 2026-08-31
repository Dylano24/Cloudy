export const GAMBLING_GAME_COMMANDS = [
  { name: 'baccarat', usage: '/baccarat amount bet', group: 'Games', description: 'Bet on Player, Banker, or Tie.' },
  { name: 'blackjack', usage: '/blackjack amount', group: 'Games', description: 'Play a complete blackjack hand.' },
  { name: 'roulette', usage: '/roulette amount bet', group: 'Games', description: 'Bet red, black, even, odd, or a number.' },
  { name: 'slots', usage: '/slots amount', group: 'Games', description: 'Spin the slot machine.' },
  { name: 'beg', usage: '/beg', group: 'Earn money', description: 'Beg for some cash.' },
  { name: 'crime', usage: '/crime', group: 'Earn money', description: 'Attempt a crime for a possible cash reward.' },
  { name: 'daily', usage: '/daily', group: 'Earn money', description: 'Claim your daily economy reward.' },
  { name: 'rob', usage: '/rob', group: 'Earn money', description: 'Attempt to rob another member.' },
  { name: 'slut', usage: '/slut', group: 'Earn money', description: 'Use the economy risk/reward command.' },
  { name: 'work', usage: '/work', group: 'Earn money', description: 'Work for an economy reward.' },
  { name: 'balance', usage: '/balance', group: 'Economy', description: 'View your current economy balance.' },
  { name: 'deposit', usage: '/deposit', group: 'Economy', description: 'Move cash into your bank.' },
  { name: 'withdraw', usage: '/withdraw', group: 'Economy', description: 'Move money out of your bank.' },
  { name: 'pay', usage: '/pay', group: 'Economy', description: 'Pay another member.' },
  { name: 'inventory', usage: '/inventory', group: 'Economy', description: 'View your economy inventory.' },
  { name: 'leaderboard', usage: '/leaderboard', group: 'Economy', description: 'View the economy leaderboard.' },
];

export const GAMBLING_GAME_COMMAND_NAMES = new Set(
  GAMBLING_GAME_COMMANDS.map(command => command.name),
);

// These older gambling-channel commands are intentionally no longer registered.
// Their files remain for migration safety, but Discord removes them on the next
// bulk command sync.
export const RETIRED_GAMBLING_COMMAND_NAMES = new Set([
  'gamble', 'fish', 'mine', 'count', 'fight', 'flip', 'roll',
]);

export function isRetiredGamblingCommand(commandName) {
  return RETIRED_GAMBLING_COMMAND_NAMES.has(String(commandName || '').toLowerCase());
}

export function isGamblingGameCommand(commandName) {
  const normalized = String(commandName || '').toLowerCase();
  return GAMBLING_GAME_COMMAND_NAMES.has(normalized) || RETIRED_GAMBLING_COMMAND_NAMES.has(normalized);
}

export function buildGamblingCommandListText() {
  const groups = new Map();
  for (const command of GAMBLING_GAME_COMMANDS) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }

  return [...groups.entries()]
    .map(([group, commands]) => [
      `**${group}**`,
      ...commands.map(command => `\`${command.usage}\` — ${command.description}`),
    ].join('\n'))
    .join('\n\n');
}

export function buildGamesCommandListText() {
  return GAMBLING_GAME_COMMANDS
    .filter(command => command.group === 'Games')
    .map(command => `\`${command.usage}\` — ${command.description}`)
    .join('\n');
}

export function buildGamblingGuideDescription() {
  return [
    'All Cloudy gambling, gaming and player-economy commands must be used in this channel.',
    '',
    buildGamblingCommandListText(),
    '',
    'These commands will not work in other channels.',
  ].join('\n');
}
