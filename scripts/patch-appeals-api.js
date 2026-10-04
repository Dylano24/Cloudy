import fs from 'node:fs';

const path = 'src/app.js';
const before = fs.readFileSync(path, 'utf8');
let after = before;

const importLine = "import { registerAppealsApi } from './web/appealsApi.js';";
if (!after.includes(importLine)) {
  const marker = "import { embedColorPickerPage } from './web/embedColorPickerPage.js';";
  if (after.includes(marker)) {
    after = after.replace(marker, `${marker}\n${importLine}`);
  }
}

const registration = '    registerAppealsApi(app, this);';
const parser = "    app.use('/api/appeals', express.json({ limit: '32kb' }));";
if (!after.includes(parser)) {
  const marker = "    app.use(express.json({ limit: '8kb' }));";
  after = after.replace(marker, `${parser}\n${marker}`);
}
if (!after.includes(registration)) {
  const marker = "    app.use(express.json({ limit: '8kb' }));";
  if (after.includes(marker)) {
    after = after.replace(marker, `${marker}\n\n${registration}`);
  }
}

if (after !== before) {
  fs.writeFileSync(path, after);
  console.log('[APPEALS_API_PATCH] src/app.js: patched');
} else {
  console.log('[APPEALS_API_PATCH] src/app.js: already current');
}
