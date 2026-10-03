/* global document, Node, window, MutationObserver, requestAnimationFrame */

// Offsets are raw Discord text offsets, including complete custom emoji markup.
export function shiftSelectedLines(value, start, end, direction) {
    const first = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const stop = value.indexOf('\n', last);
    const boundary = stop < 0 ? value.length : stop;
    let offset = first;
    let nextStart = start;
    let nextEnd = end;
    const selected = value.slice(first, boundary).split('\n').map(line => {
        const remove = direction < 0 ? (line.startsWith('\u2800') ? 1 : (line.match(/^ {1,2}/)?.[0].length || 0)) : 0;
        const delta = direction > 0 ? 1 : -remove;
        if (offset <= start) nextStart += delta;
        if (offset < end || start === end) nextEnd += delta;
        offset += line.length + 1;
        return direction > 0 ? '\u2800' + line : line.slice(remove);
    }).join('\n');
    return { value: value.slice(0, first) + selected + value.slice(boundary), start: Math.max(first, nextStart), end: Math.max(first, nextEnd) };
}

function installLayoutPreview(bridge, shiftLines) {
    const root = document.getElementById('layoutTools');
    if (!root || bridge.footerMode) { root?.remove(); return; }
    const preview = document.getElementById('layoutPreviews');
    let frame = null;
    function rawText(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
        if (node.dataset?.markup) return node.dataset.markup;
        if (node.nodeName === 'BR') return '\n';
        let result = Array.from(node.childNodes).map(rawText).join('');
        if ((node.nodeName === 'DIV' || node.nodeName === 'P') && result && !result.endsWith('\n')) result += '\n';
        return result;
    }
    function cursorOffset(editor, range, edge) {
        const probe = document.createRange();
        probe.selectNodeContents(editor);
        probe.setEnd(range[edge + 'Container'], range[edge + 'Offset']);
        return rawText(probe.cloneContents()).length;
    }
    function restoreRange(editor, start, end) {
        function point(offset) {
            let remaining = offset;
            for (let index = 0; index < editor.childNodes.length; index++) {
                const node = editor.childNodes[index];
                const size = rawText(node).length;
                if (node.nodeType === Node.TEXT_NODE && remaining <= size) return [node, remaining];
                if (remaining === 0) return [editor, index];
                remaining -= size;
            }
            return [editor, editor.childNodes.length];
        }
        const range = document.createRange();
        range.setStart(...point(start));
        range.setEnd(...point(end));
        editor.focus({ preventScroll: true });
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
    root.querySelectorAll('[data-shift]').forEach(button => {
        // Keep the selection when clicking with a mouse or tapping on a phone.
        button.addEventListener('pointerdown', event => event.preventDefault());
        button.addEventListener('click', () => {
            const editor = bridge.getEditor();
            const range = bridge.getRange(editor);
            if (!editor || !range || !editor.contains(range.commonAncestorContainer)) {
                bridge.status('Select text in Message or a field value first.', 'error');
                return;
            }
            const value = bridge.getValue(editor);
            if (value === null) { bridge.status('Indentation is available for Message and field values.', 'error'); return; }
            const changed = shiftLines(value, cursorOffset(editor, range, 'start'), cursorOffset(editor, range, 'end'), Number(button.dataset.shift));
            if (!bridge.setValue(editor, changed.value)) return;
            restoreRange(editor, changed.start, changed.end);
            bridge.remember(editor);
            update();
        });
    });
    function appendText(parent, raw) {
        // Build DOM nodes instead of inserting user-authored HTML.
        const pattern = /<(a?):([A-Za-z0-9_]+):([0-9]+)>|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(raw))) {
            parent.append(document.createTextNode(raw.slice(cursor, match.index)));
            if (match[3]) {
                const emoji = document.createElement('img');
                emoji.src = 'https://cdn.discordapp.com/emojis/' + match[3] + (match[1] ? '.gif' : '.webp') + '?size=64';
                emoji.alt = ':' + match[2] + ':';
                emoji.className = 'layout-emoji';
                parent.append(emoji);
            } else {
                const item = document.createElement(match[4] ? 'code' : match[5] ? 'strong' : 'em');
                item.textContent = match[4] || match[5] || match[6];
                parent.append(item);
            }
            cursor = pattern.lastIndex;
        }
        parent.append(document.createTextNode(raw.slice(cursor)));
    }
    function renderCard(card, data) {
        card.replaceChildren();
        const add = (className, text) => {
            if (!text) return;
            const block = document.createElement('div');
            block.className = className;
            appendText(block, text);
            card.append(block);
        };
        add('layout-title', data.title);
        add('layout-text', data.message);
        for (const field of data.fields) {
            add('layout-field-name', field.name);
            add('layout-text', field.value);
        }
        if (data.footer) {
            const footer = document.createElement('div');
            footer.className = 'layout-footer';
            // Discord footers are plain text, not Markdown.
            footer.textContent = data.footer;
            card.append(footer);
        }
    }
    function update() {
        const data = bridge.snapshot();
        preview.querySelectorAll('.layout-card').forEach(card => renderCard(card, data));
    }
    function queueUpdate() {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; update(); });
    }
    document.getElementById('contentFields').addEventListener('input', queueUpdate);
    new MutationObserver(queueUpdate).observe(document.getElementById('contentFields'), { childList: true, subtree: true, characterData: true });
    preview.querySelectorAll('[data-preview-width]').forEach(input => {
        input.addEventListener('input', () => {
            const width = Math.max(240, Math.min(390, Number(input.value) || 300));
            document.getElementById('phonePreview').style.width = width + 'px';
            document.getElementById('phoneWidthLabel').textContent = width + ' px';
        });
    });
    update();
}

export function addEmbedLayoutPreview(html) {
    if (html.includes('id="layoutTools"')) return html;
    const styles = `
    main:has(#layoutTools) { min-width:0; max-width:calc(100vw - 24px); }
    #layoutTools { margin-top:18px; }
    .layout-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .layout-toolbar button { background:#1e1f22; border:1px solid #3d3f48; color:#f2f3f5; padding:9px 12px; border-radius:6px; cursor:pointer; }
    .layout-toolbar button:focus-visible { outline:2px solid #5865f2; }
    #layoutTools p { margin:10px 0; }
    #layoutPreviews { margin-top:14px; }
    #layoutPreviews summary { cursor:pointer; font-weight:700; }
    .layout-frame { overflow-x:auto; margin:12px 0; padding:8px 0; }
    .layout-card { padding:12px 16px; background:#2b2d31; border-left:4px solid #fff; border-radius:4px; font:16px/1.375 "Segoe UI",sans-serif; }
    #desktopPreview { width:520px; } #phonePreview { width:300px; }
    .layout-title { font-weight:700; margin-bottom:8px; }
    .layout-text, .layout-field-name { white-space:pre-wrap; overflow-wrap:break-word; }
    .layout-field-name { font-weight:700; margin:16px 0 4px; }
    .layout-emoji { width:18px; height:18px; vertical-align:-4px; object-fit:contain; }
    .layout-card code { font:85% ui-monospace,monospace; background:#1e1f22; border-radius:3px; padding:1px 3px; white-space:normal; }
    .layout-footer { font-size:12px; margin-top:12px; }
    .layout-width { display:flex; gap:10px; align-items:center; } .layout-width label { margin:0; }
    `;
    const controls = `<section id="layoutTools" aria-label="Spacing and previews">
        <div class="layout-toolbar" role="group" aria-label="Move selected lines">
            <button type="button" data-shift="-1">← Move left</button>
            <button type="button" data-shift="1">Move right →</button>
        </div>
        <p>Select lines in Message or a field value to move them. Manual spacing is saved; automatic wrapping depends on the screen width.</p>
        <details id="layoutPreviews" open><summary>Desktop and phone previews</summary>
            <p>Text layout preview. Check the final result in Discord; app fonts, zoom and some Markdown can differ.</p>
            <label>Desktop · 520 px</label><div class="layout-frame"><article id="desktopPreview" class="layout-card" aria-label="Desktop preview"></article></div>
            <div class="layout-width"><label for="phoneWidth">Phone</label><input id="phoneWidth" data-preview-width type="range" min="240" max="390" step="10" value="300"><span id="phoneWidthLabel">300 px</span></div>
            <div class="layout-frame"><article id="phonePreview" class="layout-card" aria-label="Phone preview"></article></div>
        </details>
    </section>`;
    const bridge = `
      (${installLayoutPreview.toString()})({
        footerMode: mode === 'footer',
        status: setStatus,
        getEditor: () => activeField,
        getRange: editor => editor === messageEditor ? messageRange : fieldEditors.get(editor)?.range,
        getValue: editor => editor === messageEditor ? messageInput.value : (fieldEditors.get(editor)?.allowNewlines ? fieldEditors.get(editor).input.value : null),
        setValue: (editor, value) => {
          const state = fieldEditors.get(editor);
          const limit = editor === messageEditor ? 4096 : Number(state?.input.maxLength || 0);
          if (value.length > limit) { setStatus('This indentation would exceed the field character limit.', 'error'); return false; }
          if (editor === messageEditor) { renderMessageEditor(value); return syncMessageFromEditor(); }
          renderFieldEditor(editor, value); return syncFieldFromEditor(editor);
        },
        remember: editor => editor === messageEditor ? rememberRange(editor, 'message') : rememberFieldRange(editor),
        snapshot: () => ({ title: titleInput.value, message: messageInput.value, footer: footerInput.value,
          fields: Array.from(embedFields.querySelectorAll('.embed-field')).map(section => ({ name: section.querySelector('.field-name-input').value, value: section.querySelector('.field-value-input').value })) })
      }, ${shiftSelectedLines.toString()});
    `;
    const marker = '      function renderExistingFields(fields) {';
    if (!html.includes(marker)) throw new Error('Embed layout preview integration marker is missing.');
    return html.replace('</style>', styles + '</style>')
        .replace('      <div id="status" role="status"></div>', controls + '\n      <div id="status" role="status"></div>')
        .replace(marker, bridge + '\n' + marker);
}
