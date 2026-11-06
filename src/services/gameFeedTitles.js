// Titles of the game server feed embeds and boards. Their colours are fixed
// in gameFeedService / gameServerBoardsService, so saved or auto-learned
// response templates must never restyle them.
const TITLES = new Set([
  'player killed', 'player login', 'player logout', 'kit claimed', 'player online', 'player offline', 'zorp on', 'zorp off', 'zorp', 'login', 'logout',
  'raid alert', 'player banned', 'player unbanned', 'banned', 'ban', 'unban', 'wipe incoming', 'server wiped',
  'server status', 'population', 'leaderboard', 'server changes',
]);

const FEED_FOOTER = /^© Cloudy Inc\. • .+ • (?:kill|player|zorp|raid|ban|wipe|leaderboard)$/;

// Player killed titles are "<killer> <skull> <victim>" (owner's choice).
const KILL_TITLE = /<a?:cloudy_headshot:\d+>/;

export function isGameFeedEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : embed;
  if (FEED_FOOTER.test(String(data?.footer?.text || ''))) return true;
  if (KILL_TITLE.test(String(data?.title || '')) && String(data?.footer?.text || '').startsWith('© Cloudy Inc.')) return true;
  return TITLES.has(String(data?.title || '').replace(/<a?:\w+:\d+>/g, '').trim().toLowerCase())
    && String(data?.footer?.text || '').startsWith('© Cloudy Inc.');
}
