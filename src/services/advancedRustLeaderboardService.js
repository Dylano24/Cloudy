import { unwrapReplitData } from '../utils/database.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from './gameFeedService.js';

export function calculateRustPlayerStats(stats) {
  const kills = Math.max(0, Math.trunc(Number(stats?.kills) || 0));
  const deaths = Math.max(0, Math.trunc(Number(stats?.deaths) || 0));
  return { kills, deaths, kd: deaths === 0 ? kills : kills / deaths };
}

function safeName(name) {
  return String(name).replace(/[\r\n\x60<>@*_|~]/g, '').trim().slice(0, 40) || 'Unknown player';
}

export function buildAdvancedRustLeaderboard(state, serverName = null) {
  const boards = state && typeof state === 'object' ? (state.leaderboard || {}) : {};
  const selected = Object.entries(boards)
    .filter(([server]) => !serverName || server.toLowerCase() === serverName.toLowerCase())
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .slice(0, 5);
  const embeds = selected.map(([name, board]) => {
    const ranked = Object.entries(board.players || {})
      .map(([player, stats]) => ({ player: safeName(player), ...calculateRustPlayerStats(stats) }))
      .sort((a, b) => (b.kills - a.kills) || (b.kd - a.kd) || (a.deaths - b.deaths))
      .slice(0, 10);
    const lines = ranked.map((item, index) =>
      '**' + (index + 1) + '.** ' + item.player
      + '\nKills ' + item.kills + ' · Deaths ' + item.deaths + ' · K/D ' + item.kd.toFixed(2));
    return {
      title: 'Rust leaderboard',
      description: '**' + safeName(name) + '**\n\n'
        + (lines.length ? lines.join('\n\n') : 'No player statistics yet.')
        + (Number.isFinite(board.since) ? '\n\n**Since wipe:** <t:' + Math.floor(board.since / 1000) + ':d>' : ''),
      color: 0xFFFFFF,
      thumbnail: { url: CLOUDY_C_LOGO_URL },
      footer: { text: CLOUDY_FOOTER },
    };
  });
  return embeds.length ? embeds : [{
    title: 'Rust leaderboard', description: 'No live Rust statistics yet.',
    color: 0xFFFFFF, thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  }];
}

export async function readAdvancedRustLeaderboard(client, guildId, server = null) {
  const raw = unwrapReplitData(await client.db.get('guild:' + guildId + ':gameserver:boards:v1'));
  return buildAdvancedRustLeaderboard(raw, server);
}
