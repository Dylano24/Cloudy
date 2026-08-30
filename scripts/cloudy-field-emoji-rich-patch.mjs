import fs from 'node:fs';

const file = 'src/web/embedColorPickerPage.js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
`    input[type=text], textarea, #titleEditor, #messageEditor { width: 100%; border: 1px solid #3d3f48; outline: 0; color: #f2f3f5; background: #1e1f22; border-radius: 8px; padding: 12px 13px; font: 15px inherit; }
    textarea { min-height: 170px; line-height: 1.45; resize: vertical; }
    input[type=text]:focus, textarea:focus, #titleEditor:focus, #messageEditor:focus { border-color: #5865f2; }
    #titleEditor { min-height: 43px; line-height: 1.2; white-space: nowrap; overflow-x: auto; overflow-y: hidden; cursor: text; }
    #titleEditor:empty::before, #messageEditor:empty::before { content: attr(data-placeholder); color: #949ba4; pointer-events: none; }
    #titleEditor .title-emoji, #messageEditor .message-emoji { width: 24px; height: 24px; object-fit: contain; vertical-align: -6px; margin: 0 1px; user-select: all; cursor: pointer; }
    #messageEditor { min-height: 170px; max-height: 520px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }
    #embedFields:empty { display: none; }
    .embed-field { margin-top: 18px; padding-top: 2px; border-top: 1px solid #35363e; }
    .embed-field textarea { min-height: 110px; }`,
`    input[type=text], textarea, #titleEditor, #messageEditor, .field-rich-editor { width: 100%; border: 1px solid #3d3f48; outline: 0; color: #f2f3f5; background: #1e1f22; border-radius: 8px; padding: 12px 13px; font: 15px inherit; }
    textarea { min-height: 170px; line-height: 1.45; resize: vertical; }
    input[type=text]:focus, textarea:focus, #titleEditor:focus, #messageEditor:focus, .field-rich-editor:focus { border-color: #5865f2; }
    #titleEditor, .field-name-editor { min-height: 43px; line-height: 1.2; white-space: nowrap; overflow-x: auto; overflow-y: hidden; cursor: text; }
    #titleEditor:empty::before, #messageEditor:empty::before, .field-rich-editor:empty::before { content: attr(data-placeholder); color: #949ba4; pointer-events: none; }
    #titleEditor .title-emoji, #messageEditor .message-emoji, .field-rich-editor .field-emoji { width: 24px; height: 24px; object-fit: contain; vertical-align: -6px; margin: 0 1px; user-select: all; cursor: pointer; }
    #messageEditor { min-height: 170px; max-height: 520px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }
    #embedFields:empty { display: none; }
    .embed-field { margin-top: 18px; padding-top: 2px; border-top: 1px solid #35363e; }
    .field-value-editor { min-height: 110px; max-height: 420px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }`,
'field rich-editor CSS');

replaceOnce(
`      let lastValidTitle = '';
      let lastValidMessage = '';`,
`      let lastValidTitle = '';
      let lastValidMessage = '';
      const fieldEditors = new WeakMap();`,
'field editor state');

replaceOnce(
`      function focusEditorEnd(editor, type) {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (type === 'title') titleRange = range.cloneRange();
        else messageRange = range.cloneRange();
      }

      function syncTitleFromEditor() {`,
`      function focusEditorEnd(editor, type) {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (type === 'title') titleRange = range.cloneRange();
        else messageRange = range.cloneRange();
      }

      function rememberFieldRange(editor) {
        const state = fieldEditors.get(editor);
        if (!state) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!selectionIsInside(range, editor)) return;
        state.range = range.cloneRange();
      }

      function focusFieldEditorEnd(editor) {
        const state = fieldEditors.get(editor);
        if (!state) return;
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        state.range = range.cloneRange();
      }

      function serializeFieldEditor(editor) {
        const state = fieldEditors.get(editor);
        if (!state) return '';
        return serializeRichEditor(editor, 'img.field-emoji[data-markup]', state.allowNewlines);
      }

      function renderFieldEditor(editor, raw) {
        renderRichEditor(editor, raw, 'field-emoji', () => syncFieldFromEditor(editor));
      }

      function syncFieldFromEditor(editor) {
        const state = fieldEditors.get(editor);
        if (!state) return false;
        const value = serializeFieldEditor(editor);
        const limit = Number(state.input.maxLength);
        if (value.length > limit) {
          renderFieldEditor(editor, state.lastValid);
          state.input.value = state.lastValid;
          focusFieldEditorEnd(editor);
          updateCount(state.input);
          setStatus(state.label + ' cannot exceed ' + limit + ' characters.', 'error');
          return false;
        }
        state.lastValid = value;
        state.input.value = value;
        scheduleSave(state.input);
        return true;
      }

      function bindFieldEditor(editor, input, options) {
        const state = {
          input,
          allowNewlines: Boolean(options.allowNewlines),
          label: options.label,
          lastValid: input.value || '',
          range: null,
        };
        fieldEditors.set(editor, state);
        editor.dataset.richFieldEditor = 'true';
        renderFieldEditor(editor, state.lastValid);

        const activate = () => {
          activeField = editor;
          rememberFieldRange(editor);
        };
        editor.addEventListener('focus', activate);
        editor.addEventListener('click', activate);
        editor.addEventListener('keyup', () => rememberFieldRange(editor));
        editor.addEventListener('mouseup', () => rememberFieldRange(editor));
        editor.addEventListener('input', () => {
          activeField = editor;
          if (syncFieldFromEditor(editor)) rememberFieldRange(editor);
        });
        editor.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (!state.allowNewlines) return;
          const selection = window.getSelection();
          const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
          if (!range || !selectionIsInside(range, editor)) return;
          range.deleteContents();
          const newlineNode = document.createTextNode(String.fromCharCode(10));
          range.insertNode(newlineNode);
          range.setStartAfter(newlineNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          state.range = range.cloneRange();
          syncFieldFromEditor(editor);
        });
        editor.addEventListener('paste', event => {
          event.preventDefault();
          let text = (event.clipboardData || window.clipboardData).getData('text/plain');
          if (!state.allowNewlines) {
            text = text.split(String.fromCharCode(13)).join(' ');
            text = text.split(String.fromCharCode(10)).join(' ');
          }
          const selection = window.getSelection();
          let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
          if (!range || !selectionIsInside(range, editor)) {
            range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
          }
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          state.range = range.cloneRange();
          activeField = editor;
          syncFieldFromEditor(editor);
        });
        updateCount(input);
      }

      function insertEmojiIntoFieldEditor(editor, emoji, markup) {
        const state = fieldEditors.get(editor);
        if (!state) return;
        const current = serializeFieldEditor(editor);
        const limit = Number(state.input.maxLength);
        if (current.length + markup.length > limit) {
          setStatus('That emoji would exceed the field limit.', 'error');
          return;
        }
        editor.focus();
        const selection = window.getSelection();
        let range = state.range && selectionIsInside(state.range, editor) ? state.range.cloneRange() : null;
        if (!range) {
          range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
        }
        range.deleteContents();
        const image = createRichEmoji(emoji, markup, 'field-emoji', () => syncFieldFromEditor(editor));
        range.insertNode(image);
        range.setStartAfter(image);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        state.range = range.cloneRange();
        activeField = editor;
        syncFieldFromEditor(editor);
      }

      function syncTitleFromEditor() {`,
'generic field rich-editor helpers');

replaceOnce(
`      document.addEventListener('selectionchange', () => {
        if (document.activeElement === titleEditor) rememberRange(titleEditor, 'title');
        else if (document.activeElement === messageEditor) rememberRange(messageEditor, 'message');
      });`,
`      document.addEventListener('selectionchange', () => {
        if (document.activeElement === titleEditor) rememberRange(titleEditor, 'title');
        else if (document.activeElement === messageEditor) rememberRange(messageEditor, 'message');
        else if (document.activeElement?.dataset?.richFieldEditor === 'true') rememberFieldRange(document.activeElement);
      });`,
'field selection tracking');

replaceOnce(
`            if (activeField === messageEditor || activeField === messageInput) {
              insertEmojiIntoRichEditor(messageEditor, 'message', emoji, markup);
              return;
            }
            const input = activeField || footerInput;`,
`            if (activeField === messageEditor || activeField === messageInput) {
              insertEmojiIntoRichEditor(messageEditor, 'message', emoji, markup);
              return;
            }
            if (activeField?.dataset?.richFieldEditor === 'true') {
              insertEmojiIntoFieldEditor(activeField, emoji, markup);
              return;
            }
            const input = activeField || footerInput;`,
'emoji insertion for fields');

replaceOnce(
`          section.innerHTML =
            '<div class="row"><label>Field ' + (index + 1) + ' name</label><span id="' + nameCountId + '" class="count"></span></div>' +
            '<input type="text" maxlength="256">' +
            '<div class="row"><label>Field ' + (index + 1) + ' value</label><span id="' + valueCountId + '" class="count"></span></div>' +
            '<textarea maxlength="1024"></textarea>';

          const nameInput = section.querySelector('input');
          const valueInput = section.querySelector('textarea');
          nameInput.value = field?.name || '';
          valueInput.value = field?.value || '';
          nameInput.dataset.sessionField = 'embed_field_name:' + index;
          valueInput.dataset.sessionField = 'embed_field_value:' + index;
          nameInput.dataset.countId = nameCountId;
          valueInput.dataset.countId = valueCountId;
          embedFields.appendChild(section);

          [nameInput, valueInput].forEach(input => {
            input.addEventListener('focus', () => { activeField = input; });
            input.addEventListener('click', () => { activeField = input; });
            input.addEventListener('keyup', () => { activeField = input; });
            input.addEventListener('input', () => scheduleSave(input));
            updateCount(input);
          });`,
`          section.innerHTML =
            '<div class="row"><label>Field ' + (index + 1) + ' name</label><span id="' + nameCountId + '" class="count"></span></div>' +
            '<input class="field-name-input hidden" type="text" maxlength="256" aria-hidden="true">' +
            '<div class="field-rich-editor field-name-editor" contenteditable="true" role="textbox" aria-multiline="false" data-placeholder="Field name"></div>' +
            '<div class="row"><label>Field ' + (index + 1) + ' value</label><span id="' + valueCountId + '" class="count"></span></div>' +
            '<textarea class="field-value-input hidden" maxlength="1024" aria-hidden="true"></textarea>' +
            '<div class="field-rich-editor field-value-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Field value"></div>';

          const nameInput = section.querySelector('.field-name-input');
          const valueInput = section.querySelector('.field-value-input');
          const nameEditor = section.querySelector('.field-name-editor');
          const valueEditor = section.querySelector('.field-value-editor');
          nameInput.value = field?.name || '';
          valueInput.value = field?.value || '';
          nameInput.dataset.sessionField = 'embed_field_name:' + index;
          valueInput.dataset.sessionField = 'embed_field_value:' + index;
          nameInput.dataset.countId = nameCountId;
          valueInput.dataset.countId = valueCountId;
          embedFields.appendChild(section);

          bindFieldEditor(nameEditor, nameInput, { allowNewlines: false, label: 'Field name' });
          bindFieldEditor(valueEditor, valueInput, { allowNewlines: true, label: 'Field value' });`,
'render field rich editors');

fs.writeFileSync(file, source);
console.log('Patched field name/value rich emoji editors without changing the save API or field limits.');
