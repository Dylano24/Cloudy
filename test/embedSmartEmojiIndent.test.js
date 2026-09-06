import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatSmartEmojiIndent,
    SMART_INDENT_CONTINUATION,
} from '../src/utils/embedSmartEmojiIndent.js';

test('selected glowing dot wraps continuation under the text column', () => {
    const emoji = '<:W8733476glowingdotred:123456789012345678>';
    const input = `${emoji} If a player switches teams, their existing ZORP zone will be removed to prevent abuse.`;
    const result = formatSmartEmojiIndent(input).split('\n');

    assert.equal(
        result[0],
        `${emoji} If a player switches teams, their existing ZORP zone will be removed to prevent`,
    );
    assert.equal(result[1], `${SMART_INDENT_CONTINUATION}abuse.`);
});

test('blank line ends selected emoji indentation block', () => {
    const emoji = '<:W87205667glowingdotwhite:123456789012345678>';
    const separateText = 'This text must stay completely separate.';
    const input = `${emoji} ${'word '.repeat(30).trim()}\n\n${separateText}`;
    const result = formatSmartEmojiIndent(input).split('\n');

    assert.equal(result.at(-2), '');
    assert.equal(result.at(-1), separateText);
});

test('unlisted custom emojis are untouched', () => {
    const input = '<:somethingElse:123456789012345678> This is a normal embed line that Cloudy must not change.';
    assert.equal(formatSmartEmojiIndent(input), input);
});

test('animated selected arrows use the same indentation behavior', () => {
    const emoji = '<a:W8583918animatedarrowgreen:123456789012345678>';
    const input = `${emoji} ${'Long arrow text '.repeat(12).trim()}`;
    const result = formatSmartEmojiIndent(input).split('\n');

    assert.ok(result.length > 1);
    assert.ok(result[1].startsWith(SMART_INDENT_CONTINUATION));
});
