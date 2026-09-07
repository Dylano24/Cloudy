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

// Tuned to the normal Discord embed description width. The text column is
// deliberately independent from the emoji markup length because Discord
// renders a custom emoji as one visual icon, not as its raw <:name:id> text.
const SMART_TEXT_COLUMNS = 79;
// Discord trims whitespace at the beginning of embed text lines. Put a
// zero-width-space anchor first, then normal spaces. The spaces are no longer
// leading whitespace and Discord keeps their visual width, placing wrapped
// text under the first character after the custom emoji.
const CONTINUATION_INDENT = '\u200B     ';
const CUSTOM_EMOJI_LINE = /^(\s*)(<a?:([^:>]+):\d+>)[ \t]+(.*)$/;
const ANY_CUSTOM_EMOJI_LINE = /^\s*<a?:[^:>]+:\d+>/;

function markdownVisibleLength(value) {
    return String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, '██')
        .replace(/\*\*|__|~~|\|\||`/g, '')
        .length;
}

function wrapTextColumn(value, maxColumns = SMART_TEXT_COLUMNS) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const lines = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && markdownVisibleLength(candidate) > maxColumns) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }

    if (current) lines.push(current);
    return lines;
}

/**
 * Applies a hanging-indent style only to blocks that begin with one of the
 * selected Cloudy custom emojis. Blank lines end the block immediately.
 * Other text and all other emojis remain untouched.
 */
export function formatSmartEmojiIndent(value) {
    if (!value) return value;

    const sourceLines = String(value).split('\n');
    const output = [];
    let activeBlock = null;

    const flushActiveBlock = () => {
        if (!activeBlock) return;

        const text = activeBlock.parts.join(' ').replace(/\s+/g, ' ').trim();
        const wrapped = wrapTextColumn(text);

        if (!wrapped.length) {
            output.push(activeBlock.emoji);
        } else {
            output.push(`${activeBlock.emoji} ${wrapped[0]}`);
            for (const line of wrapped.slice(1)) {
                output.push(`${CONTINUATION_INDENT}${line}`);
            }
        }

        activeBlock = null;
    };

    for (const line of sourceLines) {
        if (!line.trim()) {
            flushActiveBlock();
            output.push(line);
            continue;
        }

        const emojiMatch = line.match(CUSTOM_EMOJI_LINE);
        const emojiName = emojiMatch?.[3] || '';

        if (emojiMatch && SMART_INDENT_EMOJI_NAMES.has(emojiName)) {
            flushActiveBlock();
            activeBlock = {
                emoji: emojiMatch[2],
                parts: [emojiMatch[4]],
            };
            continue;
        }

        if (activeBlock) {
            if (ANY_CUSTOM_EMOJI_LINE.test(line)) {
                flushActiveBlock();
                output.push(line);
            } else {
                activeBlock.parts.push(line.trim());
            }
            continue;
        }

        output.push(line);
    }

    flushActiveBlock();
    return output.join('\n');
}

export const SMART_INDENT_CONTINUATION = CONTINUATION_INDENT;
