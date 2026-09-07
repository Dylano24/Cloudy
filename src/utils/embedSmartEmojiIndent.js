const SMART_INDENT_EMOJI_NAMES = new Set([
    'W87205667glowingdotwhite',
    'W8733476glowingdotred',
    'W87275935glowingdotpink',
    'W8580808arrowblue',
    'W8583918animatedarrowgreen',
    'W85animatedarrowred',
    'arrow_white',
    'W86arrow1',
    'W86arrow2',
    'W86arrow3',
]);

const CUSTOM_EMOJI_LINE = /^(\s*)(<a?:([^:>]+):\d+>)(?:[ \t]+|$)/;
const ANY_CUSTOM_EMOJI_LINE = /^\s*<a?:[^:>]+:\d+>/;
const LEADING_INDENT = /^([ \t]+)/;

// Discord may collapse/trim whitespace that begins an embed description line.
// Keep the exact spacing the user typed by anchoring every leading space with a
// zero-width character. Visually the normal space width remains unchanged, but
// Markdown no longer sees a removable run of leading whitespace.
function preserveLeadingIndent(line) {
    const match = String(line || '').match(LEADING_INDENT);
    if (!match) return line;

    const anchored = [...match[1]].map(character => {
        if (character === '\t') return '\u200B \u200B \u200B \u200B ';
        return '\u200B ';
    }).join('');

    return anchored + line.slice(match[1].length);
}

/**
 * Embed Builder description-only workaround for the selected Cloudy custom
 * emojis. Cloudy does not guess wrapping anymore: the user's own line breaks
 * and indentation are authoritative. A blank line ends the special block.
 */
export function formatSmartEmojiIndent(value) {
    if (!value) return value;

    const sourceLines = String(value).split('\n');
    const output = [];
    let activeBlock = false;

    for (const line of sourceLines) {
        if (!line.trim()) {
            activeBlock = false;
            output.push(line);
            continue;
        }

        const emojiMatch = line.match(CUSTOM_EMOJI_LINE);
        const emojiName = emojiMatch?.[3] || '';

        if (emojiMatch) {
            activeBlock = SMART_INDENT_EMOJI_NAMES.has(emojiName);
            output.push(line);
            continue;
        }

        if (activeBlock && ANY_CUSTOM_EMOJI_LINE.test(line)) {
            activeBlock = false;
            output.push(line);
            continue;
        }

        output.push(activeBlock ? preserveLeadingIndent(line) : line);
    }

    return output.join('\n');
}

export const SMART_INDENT_CONTINUATION = '\u200B ';
