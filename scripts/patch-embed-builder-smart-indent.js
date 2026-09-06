import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const builderTarget = path.resolve(__dirname, '../src/commands/Tools/embedbuilder.js');
const managerTarget = path.resolve(__dirname, '../src/services/embedManagerService.js');

function patchOnce(source, oldValue, newValue, label) {
    if (source.includes(newValue)) return source;
    if (!source.includes(oldValue)) {
        console.error(`[EMBED_BUILDER_SMART_INDENT] expected ${label} marker not found`);
        process.exit(1);
    }
    return source.replace(oldValue, newValue);
}

let builderSource = fs.readFileSync(builderTarget, 'utf8');
builderSource = patchOnce(
    builderSource,
    "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';",
    "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';\nimport { formatSmartEmojiIndent } from '../../utils/embedSmartEmojiIndent.js';",
    'builder import',
);
builderSource = patchOnce(
    builderSource,
    '    const chunks = splitLongText(state.message);',
    '    const chunks = splitLongText(formatSmartEmojiIndent(state.message));',
    'preview description',
);
builderSource = patchOnce(
    builderSource,
    '    const chunks = splitLongText(state.message, descriptionLimit);',
    '    const chunks = splitLongText(formatSmartEmojiIndent(state.message), descriptionLimit);',
    'posted description',
);
fs.writeFileSync(builderTarget, builderSource, 'utf8');

let managerSource = fs.readFileSync(managerTarget, 'utf8');
managerSource = patchOnce(
    managerSource,
    "import { logger } from '../utils/logger.js';",
    "import { logger } from '../utils/logger.js';\nimport { formatSmartEmojiIndent } from '../utils/embedSmartEmojiIndent.js';",
    'manager import',
);
managerSource = patchOnce(
    managerSource,
    '    if (state.message) data.description = state.message.slice(0, 4096);',
    '    if (state.message) data.description = formatSmartEmojiIndent(state.message).slice(0, 4096);',
    'modified embed description',
);
managerSource = patchOnce(
    managerSource,
    '    if (state.message) data.description = mergeTemplateDescription(source.description, state.message, peerData.description);',
    '    if (state.message) data.description = formatSmartEmojiIndent(mergeTemplateDescription(source.description, state.message, peerData.description));',
    'template peer description',
);
fs.writeFileSync(managerTarget, managerSource, 'utf8');

console.log('[EMBED_BUILDER_SMART_INDENT] patched selected custom emoji hanging indent');
