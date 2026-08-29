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
    input[type=text], textarea { width: 100%; border: 1px solid #3d3f48; outline: 0; color: #f2f3f5; background: #1e1f22; border-radius: 8px; padding: 12px 13px; font: 15px inherit; resize: vertical; }
    textarea { min-height: 170px; line-height: 1.45; }
    input[type=text]:focus, textarea:focus { border-color: #5865f2; }
    .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .count { color: #949ba4; font-size: 12px; }
    #emojiSection { margin-top: 20px; }
    #search { margin-bottom: 12px; }
    #emojis { display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 8px; max-height: 280px; overflow: auto; padding: 2px; }
    .emoji { min-height: 52px; border: 1px solid #3d3f48; background: #1e1f22; border-radius: 8px; cursor: pointer; display: grid; place-items: center; padding: 6px; }
    .emoji:hover { border-color: #5865f2; background: #2b2d31; }
    .emoji img { width: 32px; height: 32px; object-fit: contain; }
    .emoji small { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: #b5bac1; font-size: 9px; white-space: nowrap; }
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
      <p id="editorDescription">Click inside a field, then click a Cloudy server emoji. It is inserted exactly at your cursor and the Discord preview updates automatically.</p>
      <div id="contentFields">
        <div class="row"><label for="titleInput">Title</label><span id="titleCount" class="count">0 / 256</span></div>
        <input id="titleInput" type="text" maxlength="256" placeholder="Write your title here">
        <div class="row"><label for="messageInput">Message</label><span id="messageCount" class="count">0 / 4000</span></div>
        <textarea id="messageInput" maxlength="4000" placeholder="Write your message here"></textarea>
      </div>
      <div id="footerFields" class="hidden">
        <div class="row"><label for="footerInput">Footer</label><span id="footerCount" class="count">0 / 2048</span></div>
        <input id="footerInput" type="text" maxlength="2048" placeholder="Footer text">
        <p style="margin-top:10px">Discord does not render custom server emojis inside embed footer text, so the server emoji picker is disabled for the footer.</p>
      </div>
      <section id="emojiSection">
        <label for="search">Cloudy server emojis</label>
        <input id="search" type="text" placeholder="Search emojis">
        <div id="emojis"></div>
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
      const footerInput = document.getElementById('footerInput');
      const contentFields = document.getElementById('contentFields');
      const footerFields = document.getElementById('footerFields');
      const emojiSection = document.getElementById('emojiSection');
      const emojiGrid = document.getElementById('emojis');
      const search = document.getElementById('search');
      const counts = {
        title: document.getElementById('titleCount'),
        message: document.getElementById('messageCount'),
        footer: document.getElementById('footerCount'),
      };
      let emojis = [];
      let activeField = mode === 'footer' ? footerInput : messageInput;
      let saveTimer = null;

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
        if (input === messageInput) return 'message';
        return 'footer';
      }

      function updateCount(input) {
        const field = fieldName(input);
        counts[field].textContent = input.value.length + ' / ' + input.maxLength;
      }

      async function save(input) {
        const field = fieldName(input);
        const value = input.value;
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

      [titleInput, messageInput, footerInput].forEach(input => {
        input.addEventListener('focus', () => { activeField = input; });
        input.addEventListener('click', () => { activeField = input; });
        input.addEventListener('keyup', () => { activeField = input; });
        input.addEventListener('input', () => scheduleSave(input));
      });

      function emojiUrl(emoji) {
        const ext = emoji.animated ? 'gif' : 'webp';
        return 'https://cdn.discordapp.com/emojis/' + emoji.id + '.' + ext + '?size=64&quality=lossless';
      }

      function renderEmojis() {
        const needle = search.value.trim().toLowerCase();
        emojiGrid.innerHTML = '';
        emojis.filter(emoji => !needle || emoji.name.toLowerCase().includes(needle)).forEach(emoji => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'emoji';
          button.title = ':' + emoji.name + ':';
          const img = document.createElement('img');
          img.src = emojiUrl(emoji);
          img.alt = ':' + emoji.name + ':';
          const name = document.createElement('small');
          name.textContent = emoji.name;
          button.append(img, name);
          button.addEventListener('click', () => {
            const input = activeField || messageInput;
            const markup = '<' + (emoji.animated ? 'a' : '') + ':' + emoji.name + ':' + emoji.id + '>';
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
          updateCount(titleInput); updateCount(messageInput); updateCount(footerInput);
          renderEmojis();
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
