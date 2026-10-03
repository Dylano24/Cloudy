export const GAMBLING_GAME_COMMANDS = [
  { name: 'baccarat', usage: '/baccarat amount', group: 'Games', description: 'Bet any affordable amount, then choose Player, Banker, or Tie.' },
  { name: 'blackjack', usage: '/blackjack amount', group: 'Games', description: 'Play a complete blackjack hand with any affordable bet amount.' },
  { name: 'roulette', usage: '/roulette amount bet', group: 'Games', description: 'Bet any affordable amount on red, black, even, odd, or a number.' },
  { name: 'beg', usage: '/beg', group: 'Earn money', description: 'Beg for some cash.' },
  { name: 'crime', usage: '/crime', group: 'Earn money', description: 'Attempt a crime for a possible cash reward.' },
  { name: 'daily', usage: '/daily', group: 'Earn money', description: 'Claim your daily economy reward.' },
  { name: 'rob', usage: '/rob', group: 'Earn money', description: 'Attempt to rob another member.' },
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
  'slots', 'fish', 'mine', 'count', 'fight', 'flip', 'roll', 'slut',
]);

const GAMBLING_INFO_COMMAND_NAMES = new Set(['gamble', 'game']);

export function isRetiredGamblingCommand(commandName) {
  return RETIRED_GAMBLING_COMMAND_NAMES.has(String(commandName || '').toLowerCase());
}

// The owner explicitly retired this command. Strip only its list entry while
// retaining the rest of the saved guide's text, spacing and styling.
export function removeRetiredGamblingGuideCommand(data = {}) {
  if (!/^gambling & games$/i.test(String(data.title || '').trim())) return data;
  const strip = text => typeof text === 'string'
    ? text.split('\n').filter(line => !/\/(?:slut)\b/i.test(line)).join('\n') : text;
  return {
    ...data,
    ...(data.description !== undefined ? { description: strip(data.description) } : {}),
    ...(Array.isArray(data.fields) ? {
      fields: data.fields.map(field => ({ ...field, value: strip(field.value) })).filter(field => field.value),
    } : {}),
  };
}

export function isRetiredGamblingEmbed(data = {}) {
  const context = String(data.author?.name || '').match(/Cloudy context:\s*([^|]+)/i)?.[1]?.trim();
  return /^gambling\/slut(?:\/|$)/i.test(context || '');
}

export function isGamblingGameCommand(commandName) {
  const normalized = String(commandName || '').toLowerCase();
  return GAMBLING_GAME_COMMAND_NAMES.has(normalized)
    || GAMBLING_INFO_COMMAND_NAMES.has(normalized)
    || RETIRED_GAMBLING_COMMAND_NAMES.has(normalized);
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
