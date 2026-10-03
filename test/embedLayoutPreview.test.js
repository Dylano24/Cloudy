import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { shiftSelectedLines } from '../src/web/embedLayoutPreview.js';
import { embedColorPickerPage } from '../src/web/embedColorPickerPage.js';

test('selected-line indentation preserves custom emojis and words, and is reversible', () => {
    const original = '<:W87205667glowingdotwhite:1543291335036108830> If a player switches teams,\ntheir existing zone will be removed to prevent abuse.\nKeep this line.';
    const end = original.indexOf('Keep');
    const shifted = shiftSelectedLines(original, 0, end, 1);
    assert.equal(shifted.value, '\u2800' + original.replace('\ntheir', '\n\u2800their'));
    assert.equal(shiftSelectedLines(shifted.value, shifted.start, shifted.end, -1).value, original);
});

test('caret indentation does not touch adjacent lines or remove content when outdenting', () => {
    assert.equal(shiftSelectedLines('first\nsecond\nthird', 8, 8, 1).value, 'first\n\u2800second\nthird');
    assert.equal(shiftSelectedLines('emoji text\nno spaces', 0, 5, -1).value, 'emoji text\nno spaces');
    assert.equal(shiftSelectedLines('  indented', 5, 5, -1).value, 'indented');
});

test('empty and first-line caret offsets stay on the selected line', () => {
    assert.deepEqual(shiftSelectedLines('', 0, 0, 1), { value: '\u2800', start: 1, end: 1 });
    assert.equal(shiftSelectedLines('\nnext', 0, 0, 1).value, '\u2800\nnext');
});

test('generated page contains both live previews, and every inline script parses', () => {
    const html = embedColorPickerPage();
    assert.match(html, /id="desktopPreview"/);
    assert.match(html, /id="phonePreview"/);
    assert.match(html, /Move selected lines/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('live previews and indentation use the same emoji-preserving payload as Discord updates', async () => {
    const updates = [];
    const value = '<:W87205667glowingdotwhite:1543291335036108830> Keep this emoji.\nContinue to prevent abuse.';
    const dom = new JSDOM(embedColorPickerPage(), {
        url: 'https://editor.example/embed-color?session=test&mode=content',
        runScripts: 'dangerously', pretendToBeVisual: true,
        beforeParse(window) {
            window.fetch = async (_url, options) => {
                const command = JSON.parse(options.body).color;
                if (command.startsWith('__CLOUDY_EMBED_EDIT__:')) updates.push(JSON.parse(command.slice('__CLOUDY_EMBED_EDIT__:'.length)));
                const state = { title: 'ZORP Guide', message: 'Introduction', footer: 'Footer', fields: [{ name: 'Information', value }], emojis: [] };
                return { ok: true, json: async () => ({ color: command === '__CLOUDY_EMBED_STATE__' ? JSON.stringify(state) : '{}' }) };
            };
        },
    });
    const { window } = dom;
    const document = window.document;
    async function until(predicate) {
        for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise(resolve => { setTimeout(resolve, 10); });
        assert.ok(predicate());
    }
    try {
        await until(() => document.querySelector('#phonePreview img'));
        const editor = document.querySelector('.field-value-editor');
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        editor.dispatchEvent(new window.Event('mouseup'));
        document.querySelector('[data-shift="1"]').click();
        await until(() => updates.length > 0);
        assert.deepEqual(updates.at(-1), { field: 'embed_field_value:0', value: '\u2800' + value.replace('\nContinue', '\n\u2800Continue') });
        for (const id of ['desktopPreview', 'phonePreview']) {
            const card = document.getElementById(id);
            assert.equal(card.querySelector('img').alt, ':W87205667glowingdotwhite:');
            assert.match(card.textContent, /Continue to prevent abuse\./);
        }
        document.querySelector('[data-shift="-1"]').click();
        await until(() => updates.length === 2);
        assert.equal(updates.at(-1).value, value);
        const width = document.getElementById('phoneWidth');
        width.value = '240';
        width.dispatchEvent(new window.Event('input'));
        assert.equal(document.getElementById('phonePreview').style.width, '240px');
        editor.textContent = '<script>alert(1)</script>';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        await until(() => document.getElementById('phonePreview').textContent.includes('<script>'));
        assert.equal(document.getElementById('phonePreview').querySelector('script'), null);
    } finally { window.close(); }
});
