// The music player panel and the record it leaves when a song ends have one
// fixed design in every server (owner's choice: the Dylano look, white side line
// and the song's cover). A response template saved in one server ("Now playing"
// in Cloudy Inc. turned the side line green and dropped the cover) must never
// restyle them, like the game feeds (gameFeedTitles.js).
const TITLES = new Set(['now playing', 'played', 'skipped', 'stopped', 'could not play']);

export function isMusicPlayerEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed?.data || embed);
  if (!data || typeof data !== 'object') return false;
  if (!TITLES.has(String(data.title || '').trim().toLowerCase())) return false;
  if (!String(data.footer?.text || '').startsWith('© Cloudy Inc.')) return false;
  return Array.isArray(data.fields) && data.fields.some(field => field?.name === 'Requested by');
}
