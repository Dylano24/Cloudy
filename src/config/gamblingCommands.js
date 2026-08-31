export const GAMBLING_GAME_COMMANDS = [
  { name: 'gamble', usage: '/gamble [amount]', group: 'Games', description: 'View this list or bet cash for a chance to win more.' },
  { name: 'fight', usage: '/fight opponent', group: 'Games', description: 'Start a 1v1 battle with another member.' },
  { name: 'flip', usage: '/flip', group: 'Games', description: 'Flip a coin.' },
  { name: 'roll', usage: '/roll notation', group: 'Games', description: 'Roll dice, for example 2d6 or 1d20+4.' },
  { name: 'beg', usage: '/beg', group: 'Earn money', description: 'Beg for some cash.' },
  { name: 'crime', usage: '/crime', group: 'Earn money', description: 'Attempt a crime for a possible cash reward.' },
  { name: 'daily', usage: '/daily', group: 'Earn money', description: 'Claim your daily economy reward.' },
  { name: 'fish', usage: '/fish', group: 'Earn money', description: 'Go fishing for economy rewards.' },
  { name: 'mine', usage: '/mine', group: 'Earn money', description: 'Go mining for economy rewards.' },
  { name: 'rob', usage: '/rob', group: 'Earn money', description: 'Attempt to rob another member.' },
  { name: 'slut', usage: '/slut', group: 'Earn money', description: 'Use the economy risk/reward command.' },
  { name: 'work', usage: '/work', group: 'Earn money', description: 'Work for an economy reward.' },
  { name: 'balance', usage: '/balance', group: 'Economy', description: 'View your current economy balance.' },
  { name: 'deposit', usage: '/deposit', group: 'Economy', description: 'Move cash into your bank.' },
  { name: 'withdraw', usage: '/withdraw', group: 'Economy', description: 'Move money out of your bank.' },
  { name: 'pay', usage: '/pay', group: 'Economy', description: 'Pay another member.' },
  { name: 'inventory', usage: '/inventory', group: 'Economy', description: 'View your economy inventory.' },
  { name: 'eleaderboard', usage: '/eleaderboard', group: 'Economy', description: 'View the economy leaderboard.' },
  { name: 'count', usage: '/count', group: 'Game management', description: 'Manage the server counting game. Manage Server permission required.' },
];

export const GAMBLING_GAME_COMMAND_NAMES = new Set(
  GAMBLING_GAME_COMMANDS.map(command => command.name),
);

export function isGamblingGameCommand(commandName) {
  return GAMBLING_GAME_COMMAND_NAMES.has(String(commandName || '').toLowerCase());
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

export function buildGamblingGuideDescription() {
  return [
    'All Cloudy gambling, gaming and player-economy commands must be used in this channel.',
    '',
    buildGamblingCommandListText(),
    '',
    'These commands will not work in other channels.',
  ].join('\n');
}
