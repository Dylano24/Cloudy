export function embedColorPickerPage() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cloudy · Embed editor</title>
  <style>
    :root { color-scheme: dark; --hue: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111214; color: #f2f3f5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100% - 24px, 700px); background: #242429; border: 1px solid #35363e; border-radius: 14px; padding: 24px; box-shadow: 0 18px 48px #0008; }
    h1 { margin: 0 0 7px; font-size: 23px; }
    p { margin: 0 0 18px; color: #b5bac1; font-size: 14px; line-height: 1.45; }
    label { display: block; margin: 16px 0 8px; font-size: 13px; font-weight: 700; color: #dbdee1; }
    input[type=text], textarea, #messageEditor { width: 100%; border: 1px solid #3d3f48; outline: 0; color: #f2f3f5; background: #1e1f22; border-radius: 8px; padding: 12px 13px; font: 15px inherit; }
    textarea { min-height: 170px; line-height: 1.45; resize: vertical; }
    input[type=text]:focus, textarea:focus, #messageEditor:focus { border-color: #5865f2; }
    #messageEditor { min-height: 170px; max-height: 520px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: vertical; cursor: text; }
    #messageEditor:empty::before { content: attr(data-placeholder); color: #949ba4; pointer-events: none; }
    #messageEditor .message-emoji { width: 24px; height: 24px; object-fit: contain; vertical-align: -6px; margin: 0 1px; user-select: all; }
    .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .count { color: #949ba4; font-size: 12px; }
    #emojiSection { margin-top: 18px; }
    #emojiToggle { width: 100%; border: 1px solid #3d3f48; background: #1e1f22; color: #f2f3f5; border-radius: 8px; padding: 12px 14px; font: 700 15px inherit; cursor: pointer; text-align: left; }
    #emojiToggle:hover, #emojiToggle:focus-visible { border-color: #5865f2; background: #2b2d31; outline: 0; }
    #emojiPanel { margin-top: 10px; border: 1px solid #35363e; border-radius: 10px; background: #1b1c1f; padding: 12px; }
    #emojiPanel label { margin-top: 0; }
    #search { margin-bottom: 12px; }
    #emojis { display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 8px; max-height: 320px; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 2px; }
    .emoji { min-height: 54px; border: 1px solid #3d3f48; background: #1e1f22; border-radius: 8px; cursor: pointer; display: grid; place-items: center; padding: 8px; }
    .emoji:hover { border-color: #5865f2; background: #2b2d31; }
    .emoji img { width: 36px; height: 36px; object-fit: contain; }
    #status { min-height: 19px; margin: 14px 0 0; text-align: center; font-size: 13px; color: #b5bac1; }
    #status.ok { color: #57f287; } #status.error { color: #ed4245; }
    #colorMode { display: none; }
    #area { --color: hsl(var(--hue), 100%, 50%); position: relative; width: 100%; aspect-ratio: 1.42; border-radius: 8px; cursor: crosshair; touch-action: none; background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--color)); box-shadow: inset 0 0 0 1px #0005; }
    #cursor { position: absolute; width: 18px; height: 18px; border: 3px solid #fff; border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px #000; pointer-events: none; }
    .hue-wrap { position: relative; margin: 18px 0 22px; height: 16px; display: grid; align-items: center; }
    #hue { width: 100%; appearance: none; height: 9px; border-radius: 999px; outline: none; background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); cursor: ew-resize; }
    #hue::-webkit-slider-thumb { appearance: none; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; background: transparent; box-shadow: 0 0 0 1px #000; }
    #hue::-moz-range-thumb { width: 13px; height: 13px; border-radius: 50%; border: 3px solid #fff; background: transparent; box-shadow: 0 0 0 1px #000; }
    .hex { display: flex; align-items: center; gap: 10px; border: 1px solid #3d3f48; background: #1e1f22; border-radius: 8px; padding: 0 13px; }
    .swatch { width: 20px; height: 20px; border-radius: 5px; background: #000; border: 1px solid #ffffff44; flex: 0 0 auto; }
    .hex input { border: 0; padding-left: 0; padding-right: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    button.primary { width: 100%; margin-top: 18px; border: 0; border-radius: 8px; padding: 13px 16px; font: 700 15px inherit; background: #5865f2; color: #fff; cursor: pointer; }
    button.primary:hover { background: #4752c4; } button.primary:disabled { opacity: .65; cursor: wait; }
    .quick-label { margin-top: 18px; } .quick { display: grid; grid-template-columns: repeat(9, 1fr); gap: 8px; }
    .quick button { width: auto; aspect-ratio: 1; margin: 0; padding: 0; border: 2px solid transparent; border-radius: 7px; background: var(--swatch); box-shadow: inset 0 0 0 1px #0004; }
    .quick button:hover, .quick button:focus-visible { border-color: #fff; background: var(--swatch); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <main>
    <section id="editorMode" class="hidden">
      <h1 id="editorTitle">Edit title and message</h1>
      <p id="editorDescription">Click inside a field, then choose an emoji. It is inserted exactly at your cursor and the Discord preview updates automatically.</p>
      <div id="contentFields">
        <div class="row"><label for="titleInput">Title</label><span id="titleCount" class="count">0 / 256</span></div>
        <input id="titleInput" type="text" maxlength="256" placeholder="Write your title here">
        <div class="row"><label for="messageEditor">Message</label><span id="messageCount" class="count">0 / 4000</span></div>
        <textarea id="messageInput" maxlength="4000" class="hidden" aria-hidden="true"></textarea>
        <div id="messageEditor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Write your message here"></div>
      </div>
      <div id="footerFields" class="hidden">
        <div class="row"><label for="footerInput">Footer</label><span id="footerCount" class="count">0 / 2048</span></div>
        <input id="footerInput" type="text" maxlength="2048" placeholder="Footer text">
        <p style="margin-top:10px">Discord does not render custom server emojis inside embed footer text, so the server emoji picker is disabled for the footer.</p>
      </div>
      <section id="emojiSection">
        <button id="emojiToggle" type="button" aria-expanded="false" aria-controls="emojiPanel">😀 Emojis</button>
        <div id="emojiPanel" class="hidden">
          <label for="search">Cloudy server emojis</label>
          <input id="search" type="text" placeholder="Search emojis" autocomplete="off">
          <div id="emojis"></div>
        </div>
      </section>
      <div id="status" role="status"></div>
    </section>

    <section id="colorMode">
      <h1>Set side color</h1>
      <p>Choose any color for the side line of your message.</p>
      <div id="area" aria-label="Color area"><span id="cursor"></span></div>
      <div class="hue-wrap"><input id="hue" type="range" min="0" max="360" value="0" aria-label="Hue"></div>
      <label for="hex">Hex color code</label>
      <div class="hex"><span id="swatch" class="swatch"></span><input id="hex" type="text" inputmode="text" maxlength="7" value="#000000" aria-label="Hex color code"></div>
      <label class="quick-label">Quick colors</label>
      <div id="quick" class="quick" aria-label="Quick colors"></div>
      <button id="apply" class="primary" type="button">Apply color</button>
      <div id="colorStatus" role="status"></div>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get('session');
    const mode = params.get('mode') || 'color';
    const apiUrl = '/api/embed-color/' + encodeURIComponent(token || '');

    async function callSession(value) {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'This editor session has expired. Reopen it from Discord.');
      return data.color;
    }

    if (mode === 'content' || mode === 'footer') {
      const editorMode = document.getElementById('editorMode');
      const status = document.getElementById('status');
      const titleInput = document.getElementById('titleInput');
      const messageInput = document.getElementById('messageInput');
      const messageEditor = document.getElementById('messageEditor');
      const footerInput = document.getElementById('footerInput');
      const contentFields = document.getElementById('contentFields');
      const footerFields = document.getElementById('footerFields');
      const emojiSection = document.getElementById('emojiSection');
      const emojiToggle = document.getElementById('emojiToggle');
      const emojiPanel = document.getElementById('emojiPanel');
      const emojiGrid = document.getElementById('emojis');
      const search = document.getElementById('search');
      const counts = {
        title: document.getElementById('titleCount'),
        message: document.getElementById('messageCount'),
        footer: document.getElementById('footerCount'),
      };
      let emojis = [];
      let activeField = mode === 'footer' ? footerInput : messageEditor;
      let saveTimer = null;
      let messageRange = null;
      let lastValidMessage = '';

      editorMode.classList.remove('hidden');
      if (mode === 'footer') {
        document.getElementById('editorTitle').textContent = 'Edit footer';
        document.getElementById('editorDescription').textContent = 'Edit the footer here. Changes are sent straight to the live Discord preview.';
        contentFields.classList.add('hidden');
        footerFields.classList.remove('hidden');
        emojiSection.classList.add('hidden');
      }

      function setStatus(text, className = '') {
        status.textContent = text;
        status.className = className;
      }

      function fieldName(input) {
        if (input === titleInput) return 'title';
        if (input === messageInput || input === messageEditor) return 'message';
        return 'footer';
      }

      function updateCount(input) {
        const field = fieldName(input);
        if (field === 'message') {
          counts.message.textContent = messageInput.value.length + ' / 4000';
          return;
        }
        counts[field].textContent = input.value.length + ' / ' + input.maxLength;
      }

      async function save(input) {
        const field = fieldName(input);
        const value = field === 'message' ? messageInput.value : input.value;
        setStatus('Updating Discord preview…');
        try {
          await callSession('__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field, value }));
          setStatus('Live preview updated.', 'ok');
        } catch (error) {
          setStatus(error.message || 'Could not update the preview.', 'error');
        }
      }

      function scheduleSave(input) {
        updateCount(input);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => save(input), 350);
      }

      [titleInput, footerInput].forEach(input => {
        input.addEventListener('focus', () => { activeField = input; });
        input.addEventListener('click', () => { activeField = input; });
        input.addEventListener('keyup', () => { activeField = input; });
        input.addEventListener('input', () => scheduleSave(input));
      });

      function emojiUrl(emoji) {
        const ext = emoji.animated ? 'gif' : 'webp';
        return 'https://cdn.discordapp.com/emojis/' + emoji.id + '.' + ext + '?size=64&quality=lossless';
      }

      function createMessageEmoji(emoji, markup) {
        const img = document.createElement('img');
        img.className = 'message-emoji';
        img.src = emojiUrl(emoji);
        img.alt = ':' + emoji.name + ':';
        img.title = ':' + emoji.name + ':';
        img.dataset.markup = markup;
        img.contentEditable = 'false';
        img.addEventListener('error', () => {
          img.replaceWith(document.createTextNode(markup));
          syncMessageFromEditor();
        }, { once: true });
        return img;
      }

      function renderMessageEditor(raw) {
        messageEditor.replaceChildren();
        const value = String(raw || '');
        const pattern = /<(a?):([A-Za-z0-9_]+):([0-9]+)>/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(value))) {
          if (match.index > cursor) messageEditor.appendChild(document.createTextNode(value.slice(cursor, match.index)));
          const markup = match[0];
          messageEditor.appendChild(createMessageEmoji({ id: match[3], name: match[2], animated: match[1] === 'a' }, markup));
          cursor = match.index + markup.length;
        }
        if (cursor < value.length) messageEditor.appendChild(document.createTextNode(value.slice(cursor)));
      }

      function serializeMessageEditor() {
        let output = '';
        const newline = String.fromCharCode(10);
        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            output += node.nodeValue || '';
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches('img.message-emoji[data-markup]')) {
            output += node.dataset.markup || '';
            return;
          }
          if (node.tagName === 'BR') {
            output += newline;
            return;
          }
          const isBlock = node !== messageEditor && (node.tagName === 'DIV' || node.tagName === 'P');
          const before = output.length;
          Array.from(node.childNodes).forEach(walk);
          if (isBlock && output.length > before && !output.endsWith(newline)) output += newline;
        }
        Array.from(messageEditor.childNodes).forEach(walk);
        while (output.endsWith(newline)) output = output.slice(0, -1);
        return output;
      }

      function selectionIsInsideMessage(range) {
        if (!range) return false;
        const container = range.commonAncestorContainer;
        const element = container.nodeType === Node.TEXT_NODE ? container.parentNode : container;
        return element === messageEditor || messageEditor.contains(element);
      }

      function rememberMessageRange() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (selectionIsInsideMessage(range)) messageRange = range.cloneRange();
      }

      function focusMessageEnd() {
        messageEditor.focus();
        const range = document.createRange();
        range.selectNodeContents(messageEditor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        messageRange = range.cloneRange();
      }

      function syncMessageFromEditor() {
        const value = serializeMessageEditor();
        if (value.length > 4000) {
          renderMessageEditor(lastValidMessage);
          messageInput.value = lastValidMessage;
          focusMessageEnd();
          updateCount(messageEditor);
          setStatus('Message cannot exceed 4000 characters.', 'error');
          return false;
        }
        lastValidMessage = value;
        messageInput.value = value;
        scheduleSave(messageInput);
        return true;
      }

      messageEditor.addEventListener('focus', () => { activeField = messageEditor; rememberMessageRange(); });
      messageEditor.addEventListener('click', () => { activeField = messageEditor; rememberMessageRange(); });
      messageEditor.addEventListener('keyup', rememberMessageRange);
      messageEditor.addEventListener('mouseup', rememberMessageRange);
      messageEditor.addEventListener('input', () => {
        activeField = messageEditor;
        if (syncMessageFromEditor()) rememberMessageRange();
      });
      messageEditor.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const selection = window.getSelection();
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !selectionIsInsideMessage(range)) return;
        range.deleteContents();
        const newlineNode = document.createTextNode(String.fromCharCode(10));
        range.insertNode(newlineNode);
        range.setStartAfter(newlineNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        messageRange = range.cloneRange();
        syncMessageFromEditor();
      });
      messageEditor.addEventListener('paste', event => {
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData('text/plain');
        const selection = window.getSelection();
        let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !selectionIsInsideMessage(range)) {
          range = document.createRange();
          range.selectNodeContents(messageEditor);
          range.collapse(false);
        }
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        messageRange = range.cloneRange();
        syncMessageFromEditor();
      });
      document.addEventListener('selectionchange', () => {
        if (document.activeElement === messageEditor) rememberMessageRange();
      });

      function emojiSearchText(emoji) {
        return String(emoji.name || '')
          .toLowerCase()
          .replace(/^cloudy[_-]*/, '')
          .replace(/[_-]+/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2');
      }

      function insertEmojiIntoMessage(emoji, markup) {
        const current = serializeMessageEditor();
        if (current.length + markup.length > 4000) {
          setStatus('That emoji would exceed the field limit.', 'error');
          return;
        }
        messageEditor.focus();
        const selection = window.getSelection();
        let range = messageRange && selectionIsInsideMessage(messageRange) ? messageRange.cloneRange() : null;
        if (!range) {
          range = document.createRange();
          range.selectNodeContents(messageEditor);
          range.collapse(false);
        }
        range.deleteContents();
        const image = createMessageEmoji(emoji, markup);
        range.insertNode(image);
        range.setStartAfter(image);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        messageRange = range.cloneRange();
        activeField = messageEditor;
        syncMessageFromEditor();
      }

      function renderEmojis() {
        const needle = search.value.trim().toLowerCase();
        emojiGrid.innerHTML = '';
        emojis.filter(emoji => {
          if (!needle) return true;
          const rawName = String(emoji.name || '').toLowerCase();
          const searchable = emojiSearchText(emoji);
          return rawName.includes(needle) || searchable.includes(needle);
        }).forEach(emoji => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'emoji';
          button.title = ':' + emoji.name + ':';
          button.setAttribute('aria-label', emojiSearchText(emoji) || 'emoji');
          const img = document.createElement('img');
          img.src = emojiUrl(emoji);
          img.alt = '';
          img.addEventListener('error', () => button.remove(), { once: true });
          button.appendChild(img);
          button.addEventListener('click', () => {
            const markup = '<' + (emoji.animated ? 'a' : '') + ':' + emoji.name + ':' + emoji.id + '>';
            if (activeField === messageEditor || activeField === messageInput) {
              insertEmojiIntoMessage(emoji, markup);
              return;
            }
            const input = activeField || titleInput;
            const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
            const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
            const next = input.value.slice(0, start) + markup + input.value.slice(end);
            if (next.length > Number(input.maxLength)) {
              setStatus('That emoji would exceed the field limit.', 'error');
              return;
            }
            input.value = next;
            const caret = start + markup.length;
            input.focus();
            input.setSelectionRange(caret, caret);
            scheduleSave(input);
          });
          emojiGrid.appendChild(button);
        });
      }

      emojiToggle.addEventListener('click', () => {
        const isOpen = !emojiPanel.classList.contains('hidden');
        emojiPanel.classList.toggle('hidden', isOpen);
        emojiToggle.setAttribute('aria-expanded', String(!isOpen));
        emojiToggle.textContent = isOpen ? '😀 Emojis' : '😀 Emojis ▲';
        if (!isOpen) {
          renderEmojis();
          requestAnimationFrame(() => search.focus({ preventScroll: true }));
        }
      });

      search.addEventListener('input', renderEmojis);

      (async () => {
        if (!token) {
          setStatus('This editor session has expired. Reopen it from Discord.', 'error');
          return;
        }
        try {
          const raw = await callSession('__CLOUDY_EMBED_STATE__');
          const data = JSON.parse(raw || '{}');
          titleInput.value = data.title || '';
          messageInput.value = data.message || '';
          footerInput.value = data.footer || '';
          emojis = Array.isArray(data.emojis) ? data.emojis : [];
          lastValidMessage = messageInput.value;
          renderMessageEditor(lastValidMessage);
          updateCount(titleInput); updateCount(messageEditor); updateCount(footerInput);
          setStatus(mode === 'footer' ? 'Footer editor ready.' : 'Emoji editor ready.');
        } catch (error) {
          setStatus(error.message || 'Could not load the editor.', 'error');
        }
      })();
    } else {
      document.getElementById('colorMode').style.display = 'block';
      const area = document.getElementById('area');
      const cursor = document.getElementById('cursor');
      const hueInput = document.getElementById('hue');
      const hex = document.getElementById('hex');
      const swatch = document.getElementById('swatch');
      const apply = document.getElementById('apply');
      const status = document.getElementById('colorStatus');
      const quick = document.getElementById('quick');
      let hue = 0, saturation = 0, value = 0;
      function hsvToRgb(h, s, v) { const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let r = 0, g = 0, b = 0; if (h < 60) [r,g,b] = [c,x,0]; else if (h < 120) [r,g,b] = [x,c,0]; else if (h < 180) [r,g,b] = [0,c,x]; else if (h < 240) [r,g,b] = [0,x,c]; else if (h < 300) [r,g,b] = [x,0,c]; else [r,g,b] = [c,0,x]; return [r,g,b].map(n => Math.round((n + m) * 255)); }
      function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min; let h = 0; if (d) { if (max === r) h = 60 * (((g - b) / d + 6) % 6); else if (max === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4); } return [h, max ? d / max : 0, max]; }
      function draw() { const rgb = hsvToRgb(hue, saturation, value); const valueHex = '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase(); document.documentElement.style.setProperty('--hue', hue); area.style.setProperty('--hue', hue); hueInput.value = String(Math.round(hue)); cursor.style.left = (saturation * 100) + '%'; cursor.style.top = ((1 - value) * 100) + '%'; hex.value = valueHex; swatch.style.background = valueHex; }
      function setFromHex(raw) { const match = raw.trim().match(/^#?([0-9a-f]{6})$/i); if (!match) return false; const code = match[1]; const [h,s,v] = rgbToHsv(parseInt(code.slice(0,2),16), parseInt(code.slice(2,4),16), parseInt(code.slice(4,6),16)); hue = h; saturation = s; value = v; draw(); return true; }
      function setPoint(event) { const rect = area.getBoundingClientRect(); saturation = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); value = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)); draw(); }
      area.addEventListener('pointerdown', event => { area.setPointerCapture(event.pointerId); setPoint(event); });
      area.addEventListener('pointermove', event => { if (event.buttons || event.pressure) setPoint(event); });
      hueInput.addEventListener('input', () => { hue = Number(hueInput.value); draw(); });
      hex.addEventListener('change', () => { if (!setFromHex(hex.value)) draw(); });
      ['#000000','#FFFFFF','#5865F2','#57F287','#FEE75C','#ED4245','#EB459E','#9B59B6','#3498DB','#1ABC9C','#E67E22','#95A5A6','#2C3E50','#11806A','#206694','#71368A','#AD1457','#992D22'].forEach(color => { const button = document.createElement('button'); button.type = 'button'; button.style.setProperty('--swatch', color); button.title = color; button.setAttribute('aria-label', color); button.addEventListener('click', () => setFromHex(color)); quick.appendChild(button); });
      const initial = params.get('color'); if (!setFromHex(initial || '#000000')) draw();
      apply.addEventListener('click', async () => { if (!token) { status.textContent = 'This color session has expired. Reopen it from Discord.'; status.className = 'error'; return; } apply.disabled = true; status.textContent = 'Applying color…'; status.className = ''; try { await callSession(hex.value); status.textContent = 'Color applied to your Discord preview.'; status.className = 'ok'; } catch (error) { status.textContent = error.message || 'Could not apply the color.'; status.className = 'error'; } finally { apply.disabled = false; } });
    }
  </script>
</body>
</html>`;
}
