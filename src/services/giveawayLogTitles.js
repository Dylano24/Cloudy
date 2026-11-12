// Giveaway logs (#giveaway-logs, the winner country log and the claim logs)
// have fixed colours and fields set when they are sent (owner's choice:
// Giveaway created white, Giveaway ended black). A response template saved
// or learned under the same title re-applied the old green/white after the
// send, so every template layer skips them, like the game feeds
// (gameFeedTitles.js) and the music player (musicPanelIdentity.js).
const TITLES = new Set([
  'giveaway created', 'giveaway ended', 'giveaway winner country',
  'giveaway claim opened', 'giveaway code revealed', 'giveaway claim closed',
  'giveaway claim auto deletion', 'giveaway auto expiry', 'giveaway claim expired',
]);

const LOG_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

export function isGiveawayLogEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed?.data || embed);
  if (!data || typeof data !== 'object') return false;
  return TITLES.has(String(data.title || '').trim().toLowerCase())
    && String(data.footer?.text || '') === LOG_FOOTER;
}
