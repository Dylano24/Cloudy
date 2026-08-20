// Top-level commands that remain as implementation modules but are exposed
// through a grouped slash command instead. Keeping this list centralized means
// the runtime loader and CI validator make exactly the same registration choice.
export const GROUPED_TOP_LEVEL_COMMANDS = new Set([
  'gcreate',
  'gdelete',
  'gend',
  'greroll',
  'motivation-config',
  'claim',
  'close',
  'priority',
]);

export function isGroupedTopLevelCommand(name) {
  return GROUPED_TOP_LEVEL_COMMANDS.has(String(name || '').toLowerCase());
}
