import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'BUILDER_PREVIEW_SESSION_CLEANUP_V1';
const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

if (before.includes(marker)) {
  console.log('[BUILDER_PREVIEW_SESSION_CLEANUP] already current');
  process.exit(0);
}

let text = before;

const placementMarker = '// BUILDER_PREVIEW_BUTTON_PLACEMENT_V1';
const placementIndex = text.indexOf(placementMarker);
if (placementIndex < 0) {
  throw new Error('[BUILDER_PREVIEW_SESSION_CLEANUP] preview placement marker missing');
}

const previewDeleteHelper = `async function deleteBuilderPreviewMessage(state) {
    const id = state.builderMessageId ? String(state.builderMessageId) : null;
    const message = state.builderMessage || null;
    const webhook = state.builderWebhook || null;

    // ${marker}: the top Builder preview is temporary UI, never a posted
    // message. Once the Message builder session ends it must disappear too.
    state.builderMessage = null;
    state.builderMessageId = null;
    state.builderWebhook = null;
    state.builderPreviewUnavailable = true;
    state.previewEditPending = null;

    if (message?.delete) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) return true;
    }
    if (id && webhook?.deleteMessage) {
        return webhook.deleteMessage(id).then(() => true).catch(() => false);
    }
    return false;
}

`;

text = text.slice(0, placementIndex)
  + previewDeleteHelper
  + text.slice(placementIndex);

const collectorStart = text.indexOf(
  'const collector = dashboardMessage.createMessageComponentCollector({',
);
if (collectorStart < 0) {
  throw new Error('[BUILDER_PREVIEW_SESSION_CLEANUP] main Builder collector missing');
}

const endStart = text.indexOf("collector.on('end', async (", collectorStart);
if (endStart < 0) {
  throw new Error('[BUILDER_PREVIEW_SESSION_CLEANUP] Builder end handler missing');
}

const bodyStart = text.indexOf('{', endStart);
if (bodyStart < 0) {
  throw new Error('[BUILDER_PREVIEW_SESSION_CLEANUP] Builder end handler body missing');
}

const endProbe = text.slice(bodyStart, bodyStart + 1200);
if (!endProbe.includes('deleteBuilderPreviewMessage(state)')) {
  const cleanup = `
                // ${marker}: dashboard cleanup and preview cleanup are one
                // lifecycle. This also covers the five-minute inactivity path,
                // where the dashboard is removed by builderSessionCleanup first.
                await deleteBuilderPreviewMessage(state).catch(() => {});
                await deleteBuilderDashboardMessage(state).catch(() => {});`;
  text = text.slice(0, bodyStart + 1) + cleanup + text.slice(bodyStart + 1);
}

fs.writeFileSync(path, text, 'utf8');
console.log('[BUILDER_PREVIEW_SESSION_CLEANUP] temporary preview now disappears whenever the Builder session ends.');
