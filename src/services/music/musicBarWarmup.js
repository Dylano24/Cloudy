// The first request of a link is the slow one: jsDelivr then fetches the picture from
// GitHub. Discord asks for the next bar picture while it edits the player card, so a
// cold picture would slow that edit down and the timer would stutter. After every start
// the bot requests all 216 bar pictures once, in the background, so they are ready.
import { PLAYER_BAR_STEPS, playerBarPictureUrl } from './musicEmbeds.js';

const PARALLEL = 6;
const TIMEOUT_MS = 10_000;

/** Requests every bar picture once; resolves with how many answered. Never rejects. */
export async function warmPlayerBarPictures(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') return 0;
    const steps = Array.from({ length: PLAYER_BAR_STEPS }, (_, step) => step);
    let warmed = 0;
    for (let index = 0; index < steps.length; index += PARALLEL) {
        await Promise.allSettled(steps.slice(index, index + PARALLEL).map(async step => {
            const response = await fetchImpl(playerBarPictureUrl(step), { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response?.ok) return;
            await response.arrayBuffer();
            warmed += 1;
        }));
    }
    return warmed;
}
