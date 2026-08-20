// Discord allows at most 100 top-level slash commands per guild.
// Keep every legacy Cloudy command visible as a standalone slash command.
// Only the later expansion modules are hidden from the root list for now.
export const GROUPED_TOP_LEVEL_COMMANDS = new Set([
  'motivation-config',
  'party',
  'motivation',
  'youtube',
  'youtube-alerts',
  'patch',
  'patch-config',
  'security',
  'giveaway',
]);

export function isGroupedTopLevelCommand(name) {
  return GROUPED_TOP_LEVEL_COMMANDS.has(String(name || '').toLowerCase());
}
