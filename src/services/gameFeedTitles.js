// Titles of the game server feed embeds and boards. Their colours are fixed
// in gameFeedService / gameServerBoardsService, so saved or auto-learned
// response templates must never restyle them.
const TITLES = new Set([
  'player killed', 'player online', 'player offline', 'zorp protection on', 'zorp protection off',
  'raid alert', 'player banned', 'player unbanned', 'wipe incoming', 'server wiped',
  'server status', 'population', 'leaderboard', 'server changes',
]);

const FEED_FOOTER = /^© Cloudy Inc\. • .+ • (?:kill|player|zorp|raid|ban|wipe|leaderboard)$/;

export function isGameFeedEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : embed;
  if (FEED_FOOTER.test(String(data?.footer?.text || ''))) return true;
  return TITLES.has(String(data?.title || '').trim().toLowerCase())
    && String(data?.footer?.text || '').startsWith('© Cloudy Inc.');
}
