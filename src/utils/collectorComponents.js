/** Component custom IDs handled by ephemeral message collectors — skip global handlers. */
const COLLECTOR_MANAGED_PREFIXES = [
  'config_select',
  'config_wizard',
  'cmdaccess_',
  'simple_embed_post_channel',
  'simple_embed_channel_page',
  'simple_embed_owner_server',
  'simple_embed_owner_emoji',
  'simple_embed_modify_select',
  'simple_embed_modify_page',
  'simple_embed_modify_channel',
  'simple_embed_modify_channel_page',
  'simple_embed_modify_embed',
  'simple_embed_modify_embed_page',
  'simple_embed_modify_back',
];

export function isCollectorManagedComponent(customId = '') {
  return COLLECTOR_MANAGED_PREFIXES.some((prefix) => customId.startsWith(prefix));
}
