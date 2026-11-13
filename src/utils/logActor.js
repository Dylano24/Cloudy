// Who did it, in a moderation log (owner's choice): Cloudy itself (AutoMod)
// is only "@Cloudy Manager", without its #tag; other people keep their tag.
export function formatLogActor(executor, botId) {
  if (!executor) return 'Unknown';
  return executor.id && executor.id === botId ? executor.toString() : `${executor.toString()} (${executor.tag})`;
}
