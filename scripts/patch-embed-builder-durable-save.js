import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const asyncTemplateSave = '        void saveEmbedTemplateDecoration(';
const durableTemplateSave = '        const templateSaved = await saveEmbedTemplateDecoration(';
if (text.includes(asyncTemplateSave)) {
    text = text.replace(asyncTemplateSave, durableTemplateSave);
} else if (!text.includes(durableTemplateSave)) {
    console.error('[EMBED_BUILDER_DURABLE_SAVE] template save marker not found');
    process.exit(1);
}

const saveEnd = ").catch(error => logger.error('Failed to persist saved embed template:', error));";
if (!text.includes("reason: 'persistence-failed'") && !text.includes("reason: 'template-save-failed'")) {
    if (!text.includes(saveEnd)) throw new Error('Template persistence result marker not found');
    text = text.replace(saveEnd, saveEnd + "\n        if (!templateSaved) return { ok: false, reason: 'persistence-failed' };");
}

const asyncCatalogSync = '            void syncSystemEmbedCatalogMessage(edited)';
const durableCatalogSync = '            await syncSystemEmbedCatalogMessage(edited)';
if (text.includes(asyncCatalogSync)) {
    text = text.replace(asyncCatalogSync, durableCatalogSync);
} else if (!text.includes(durableCatalogSync)) {
    console.error('[EMBED_BUILDER_DURABLE_SAVE] catalog sync marker not found');
    process.exit(1);
}

const asyncRegistryRefresh = '    void registerCloudyEmbedMessage(edited, registrySource)';
const durableRegistryRefresh = '    await registerCloudyEmbedMessage(edited, registrySource)';
if (text.includes(asyncRegistryRefresh)) {
    text = text.replace(asyncRegistryRefresh, durableRegistryRefresh);
} else if (!text.includes(durableRegistryRefresh)) {
    console.error('[EMBED_BUILDER_DURABLE_SAVE] registry refresh marker not found');
    process.exit(1);
}

if (text !== before) fs.writeFileSync(path, text, 'utf8');
console.log(`[EMBED_BUILDER_DURABLE_SAVE] ${text === before ? 'already current' : 'patched durable template and registry persistence'}`);
