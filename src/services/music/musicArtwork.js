// The sharpest cover of a song for the player card (owner's choice: the cover in
// exactly the quality of its source, however the song was added). Nodes often
// give a small copy: YouTube 320x180 (or 480x360 with black bars), YouTube Music
// 60-120 px, Spotify 300 or 64 px, SoundCloud 100 px, Apple Music and Deezer a
// few hundred px. The large copy of the same picture lives at a known address on
// the same host; it is checked once (they do not always exist) and remembered.
const GOOGLE_HOSTS = /^https:\/\/(?:lh\d\.googleusercontent\.com|yt\d\.ggpht\.com|yt\d\.googleusercontent\.com)\//i;
const CHECK_TIMEOUT_MS = 1_500;
const MAX_REMEMBERED = 500;
const remembered = new Map();

/** Larger copies of the same cover, best first (only for the hosts above and below). */
export function sharperArtworkCandidates(url) {
    const youtube = url.match(/^https:\/\/i\d*\.ytimg\.com\/(?:vi|vi_webp)\/([\w-]{6,20})\/[^/?#]+/i);
    if (youtube) return ['maxresdefault.jpg', 'hq720.jpg'].map(name => `https://i.ytimg.com/vi/${youtube[1]}/${name}`);
    if (GOOGLE_HOSTS.test(url)) {
        const sized = url.match(/^([^=?#]+)=(?:[swh]\d+)[^?#]*$/i);
        return sized ? [`${sized[1]}=w1200-h1200-l90-rj`] : [];
    }
    const spotify = url.match(/^https:\/\/i\.scdn\.co\/image\/ab67616d0000(?:1e02|4851)([0-9a-f]+)$/i);
    if (spotify) return [`https://i.scdn.co/image/ab67616d0000b273${spotify[1]}`];
    const soundcloud = url.match(/^(https:\/\/i\d*\.sndcdn\.com\/artworks-[\w-]+?)-(?:large|t300x300|small|badge|tiny|mini|crop)\.(jpg|png)$/i);
    if (soundcloud) return [`${soundcloud[1]}-t500x500.${soundcloud[2]}`];
    const apple = url.match(/^(https:\/\/is\d+-ssl\.mzstatic\.com\/image\/thumb\/.+\/)(\d+)x(\d+)[a-z]*\.(?:jpg|jpeg|png|webp)$/i);
    if (apple && Number(apple[2]) < 1000) return [`${apple[1]}1000x1000bb.jpg`];
    const deezer = url.match(/^(https:\/\/(?:e-)?cdns?-images\.dzcdn\.net\/images\/cover\/[0-9a-f]+\/)(\d+)x(\d+)(-[\w-]+\.jpg)$/i);
    if (deezer && Number(deezer[2]) < 1000) return [`${deezer[1]}1000x1000${deezer[4]}`];
    return [];
}

function remember(url, best) {
    remembered.set(url, best);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    return best;
}

async function pictureExists(url, fetchImpl) {
    try {
        const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        return response.ok && !/^text\//i.test(response.headers?.get?.('content-type') || '');
    } catch {
        return false;
    }
}

/** The best picture for this cover link; the link itself when nothing better exists. */
export async function bestArtworkUrl(url, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return url || null;
    const candidates = sharperArtworkCandidates(url);
    if (!candidates.length || typeof fetchImpl !== 'function') return url;
    if (remembered.has(url)) return remembered.get(url);
    // All are checked at once, so the card waits at most 1.5 seconds.
    const found = await Promise.all(candidates.map(candidate => pictureExists(candidate, fetchImpl)));
    return remember(url, candidates.find((_, index) => found[index]) || url);
}

/** Gives the track its sharpest cover (`cloudyArtworkUrl`) before its card is shown. */
export async function sharpenTrackArtwork(track, original, options) {
    const info = track?.info;
    if (!info || info.cloudyArtworkUrl || !original) return;
    const best = await bestArtworkUrl(original, options).catch(() => original);
    if (best && best !== original) info.cloudyArtworkUrl = best;
}
