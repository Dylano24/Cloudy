// Every music screen has one fixed design in every server (owner's choice: the
// Dylano look, white side line and the song's cover; Cloudy Inc. is the main
// server and must look exactly the same). A response template saved in one
// server ("Now playing" in Cloudy Inc. turned the side line green and dropped the
// cover) must never restyle them, like the game feeds (gameFeedTitles.js).
// The player panel and the record it leaves when a song ends:
const PANEL_TITLES = new Set(['now playing', 'played', 'skipped', 'stopped', 'could not play']);
// The queue (Queue button), the Commands explanation and the notice of the
// Add form ("Your list"; "Playlists" was its earlier panel):
const SCREEN_TITLES = new Set(['music queue', 'music commands', 'playlists', 'your list']);

export function isMusicPlayerEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed?.data || embed);
  if (!data || typeof data !== 'object') return false;
  if (!String(data.footer?.text || '').startsWith('© Cloudy Inc.')) return false;
  const title = String(data.title || '').trim().toLowerCase();
  if (SCREEN_TITLES.has(title)) return true;
  if (!PANEL_TITLES.has(title)) return false;
  return Array.isArray(data.fields) && data.fields.some(field => field?.name === 'Requested by');
}
