// Retired top-level community slash commands. Preserve their implementation
// and historical data, but never load or register them with Discord.
export const RETIRED_COMMUNITY_COMMAND_NAMES = Object.freeze([
  'birthday',
  'level',
  'leveladd',
  'levelremove',
  'levelset',
  'rank',
]);

const names = new Set(RETIRED_COMMUNITY_COMMAND_NAMES);
export function isRetiredCommunityCommand(commandName) {
  return names.has(String(commandName || '').toLowerCase());
}
