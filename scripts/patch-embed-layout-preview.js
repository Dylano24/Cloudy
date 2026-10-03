import fs from 'node:fs';

const target = 'src/web/embedColorPickerPage.js';
const source = fs.readFileSync(target, 'utf8');
if (!source.includes('// EMBED_LAYOUT_PREVIEW_V1')) {
    const marker = 'export function embedColorPickerPage() {';
    if (!source.includes(marker)) throw new Error('Embed editor page entry point is missing.');
    fs.writeFileSync(target,
        "import { addEmbedLayoutPreview } from './embedLayoutPreview.js';\n" + source.replace(marker, 'function embedColorPickerBasePage() {') +
        '\n// EMBED_LAYOUT_PREVIEW_V1\nexport function embedColorPickerPage() { return addEmbedLayoutPreview(embedColorPickerBasePage()); }\n');
}
console.log('[EMBED_LAYOUT_PREVIEW] Desktop/phone previews and manual line indentation enabled.');
