// Shared, presentation-only title formatting for unsaved Cloudy responses.
// Keep in sync with Search; never use this to rewrite saved or live Discord data.
function clean(value, max = 100) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const BUILDER_DISPLAY_TERMS = new Map([
    ['discord', 'Discord'], ['cloudy', 'Cloudy'], ['rust', 'Rust'],
    ['api', 'API'], ['id', 'ID'], ['url', 'URL'], ['faq', 'FAQ'],
    ['dm', 'DM'], ['ai', 'AI'], ['xp', 'XP'], ['vip', 'VIP'],
    ['2fa', '2FA'], ['oauth', 'OAuth'], ['paypal', 'PayPal'],
    ['builder', 'Builder'], ['reappear', 'Reappear'],
]);

export function commercialBuilderTitle(value) {
    const raw = clean(value, 100);
    if (!raw) return '';

    const visible = raw
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/[\uFE0F\u200D]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        // Runtime case/report/ticket numbers are instance data, not catalog names.
        .replace(/\s*#\s*\d+\s*$/g, '')
        .replace(/\b((?:report|ticket)\s+case)\s+\d+\s*$/i, '$1')
        .replace(/\b(new\s+report)\s+\d+\s*$/i, '$1');

    // Runtime placeholders are source-discovery metadata, not administrator copy.
    if (/^rolling\b.*\{dynamic\}/i.test(visible)) return 'Rolling dice';

    let text = visible
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/<[@#&!]?\d+>/g, ' ')
        .replace(/\{dynamic\}/gi, ' ')
        .replace(/[•·|]+/g, ' ')
        .replace(/[*_`~>#]+/g, ' ')
        .replace(/[-_–—]+/g, ' ')
        .replace(/\brandomuser\b/gi, 'random user')
        .replace(/\brole\s*selector\b/gi, 'role selector')
        .replace(/\bbot\s*log\b/gi, 'bot log')
        .replace(/\breport\s*logs?\b/gi, 'report logs')
        .replace(/\s+/g, ' ')
        .replace(/^(?:bot\s*log|botlog|report\s*logs?)\b(?:\s*[.:]\s*|\s+)/i, '')
        .replace(/\s+([:;,.!?])/g, '$1')
        .replace(/^[\s:;,.!?]+/g, '')
        .replace(/[\s:;]+$/g, '')
        .trim();

    if (!text) return '';
    text = text.toLowerCase();
    for (const [term, display] of BUILDER_DISPLAY_TERMS) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp('\\b' + escaped + '\\b', 'gi'), display);
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);
    return clean(text, 100);
}


/**
 * Runtime-only title parity for newly generated, unsaved Cloudy replies.
 * A dynamic value or numbered identifier in a live title must not be removed
 * by the Search label formatter. Saved/manual embeds are guarded at the caller.
 */
export function commercialUnsavedBotTitle(value) {
    const original = String(value || '').trim();
    if (!original || original.length > 100) return original;
    // Preserve identifiers, amounts, mentions, placeholders and source-owned
    // guides. These are runtime data, not a stable Search title.
    if (/\d|\{[^}]+\}|<[^>]+>|\$|https?:\/\/|\bZORP\s+Guide\b|\bGambling\s*&\s*Games\b|\b(?:guide|panel|dashboard)\s*$/i.test(original)) {
        return original;
    }
    return commercialBuilderTitle(original) || original;
}
