// discord.js fetchPins() wraps each Message in a MessagePin. Older fetchPinned()
// and existing adapters return a Collection of Messages instead.
export function getPinnedMessages(response) {
  if (Array.isArray(response?.items)) {
    return response.items.map(pin => pin?.message ?? pin).filter(Boolean);
  }
  if (typeof response?.values === 'function') return [...response.values()];
  return [];
}
