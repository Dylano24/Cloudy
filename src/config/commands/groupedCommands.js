// Top-level commands intentionally hidden from Discord's root slash-command list.
// Old Cloudy commands keep priority as standalone commands. Newer expansion
// modules are temporarily kept out of the root list so the bot stays under
// Discord's 100 top-level application-command limit without hiding legacy tools.
export const GROUPED_TOP_LEVEL_COMMANDS = new Set([
  'motivation-config',
  'party',
  'motivation',
  'youtube',
  'youtube-alerts',
  'patch',
  'patch-config',
  'security',
]);

export function isGroupedTopLevelCommand(name) {
  return GROUPED_TOP_LEVEL_COMMANDS.has(String(name || '').toLowerCase());
}
