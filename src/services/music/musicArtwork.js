// The sharpest cover of a song for the player card (owner's choice: the banner
// in perfect quality). The node often gives YouTube's small 320x180 picture or
// the 480x360 one with black bars; YouTube's 1280x720 picture exists for most
// videos but not all, so it is checked once per video and remembered. A
// SoundCloud cover is given at 100x100 and also exists at 500x500.
const YOUTUBE_PICTURE = /^https:\/\/i\.ytimg\.com\/(?:vi|vi_webp)\/([\w-]{6,20})\/[^/?#]+(?:[?#].*)?$/i;
const SOUNDCLOUD_PICTURE = /^(https:\/\/i\d*\.sndcdn\.com\/artworks-[\w-]+?)-(?:large|t300x300|small|badge|tiny|mini|crop)\.(jpg|png)$/i;
const YOUTUBE_SHARP = ['maxresdefault.jpg', 'hq720.jpg'];
const CHECK_TIMEOUT_MS = 1_500;
const MAX_REMEMBERED = 500;
const remembered = new Map();

function remember(id, url) {
    remembered.set(id, url);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    return url;
}

async function pictureExists(url, fetchImpl) {
    try {
        const response = await fetchImpl(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        return response.ok;
    } catch {
        return false;
    }
}

/** The best picture for this cover link; the link itself when nothing better exists. */
export async function bestArtworkUrl(url, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return url || null;
    const soundcloud = url.match(SOUNDCLOUD_PICTURE);
    if (soundcloud) return `${soundcloud[1]}-t500x500.${soundcloud[2]}`;
    const id = url.match(YOUTUBE_PICTURE)?.[1];
    if (!id || typeof fetchImpl !== 'function') return url;
    if (remembered.has(id)) return remembered.get(id);
    // Both are checked at once, so the card waits at most 1.5 seconds.
    const candidates = YOUTUBE_SHARP.map(name => `https://i.ytimg.com/vi/${id}/${name}`);
    const found = await Promise.all(candidates.map(candidate => pictureExists(candidate, fetchImpl)));
    const best = candidates.find((_, index) => found[index]);
    return remember(id, best || url);
}

/** Gives the track its sharpest cover (`cloudyArtworkUrl`) before its card is shown. */
export async function sharpenTrackArtwork(track, original, options) {
    const info = track?.info;
    if (!info || info.cloudyArtworkUrl || !original) return;
    const best = await bestArtworkUrl(original, options).catch(() => original);
    if (best && best !== original) info.cloudyArtworkUrl = best;
}
