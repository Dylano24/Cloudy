const lifetimes = new WeakMap();

// An explicit acknowledgement lifetime takes precedence over title heuristics,
// including a title changed by the Embed Builder.
export function setResponseLifetime(interaction, milliseconds) {
  lifetimes.set(interaction, milliseconds);
}

export function getResponseLifetime(interaction) {
  return lifetimes.get(interaction);
}
