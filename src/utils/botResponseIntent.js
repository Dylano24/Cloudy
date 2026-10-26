// Explicit bot notifications may use saved response templates inside Builder
// interactions. Owner-authored previews and controls never opt into this path.
// Keep intent outside the Discord payload and retain it across payload spreads.
const responseEmbeds = new WeakSet();

export function markBotResponsePayload(payload) {
  for (const embed of payload?.embeds || []) {
    if (embed && typeof embed === 'object') responseEmbeds.add(embed);
  }
  return payload;
}

export function isBotResponsePayload(payload) {
  return Boolean(payload?.embeds?.length)
    && payload.embeds.every(embed => responseEmbeds.has(embed));
}
