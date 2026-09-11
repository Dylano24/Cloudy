import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'BUILDER_SINGLE_PREVIEW_TARGET_V1';
const before = fs.readFileSync(path, 'utf8');

if (before.includes(marker)) {
  console.log('[EMBED_BUILDER_SINGLE_PREVIEW] already current');
  process.exit(0);
}

let text = before;

const refreshPattern = /async function refreshBuilder\(interaction, state\) \{[\s\S]*?\n\}\n\nasync function editContent/;
if (!refreshPattern.test(text)) {
  console.error('[EMBED_BUILDER_SINGLE_PREVIEW] refreshBuilder marker not found');
  process.exit(1);
}

text = text.replace(refreshPattern, `const BUILDER_PREVIEW_UNAVAILABLE_CODES = new Set([10008, 10062, 50027]);

function markBuilderPreviewUnavailable(state) {
    state.builderPreviewUnavailable = true;
    if (state.colorSessionToken) {
        deleteEmbedColorPickerSession(state.colorSessionToken);
    }
    return false;
}

// BUILDER_SINGLE_PREVIEW_TARGET_V1
// Every live preview update edits the one original /embedbuilder reply. Never
// recover a missing preview by creating a follow-up message: doing so creates a
// second builder and drops Discord's normal ephemeral Dismiss control.
export async function editBuilderPreviewMessage(state, interaction, payload) {
    if (state.builderPreviewUnavailable) return false;

    if (state.builderMessageId && state.builderWebhook?.editMessage) {
        try {
            await state.builderWebhook.editMessage(state.builderMessageId, payload);
            return true;
        } catch (error) {
            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {
                return markBuilderPreviewUnavailable(state);
            }
            throw error;
        }
    }

    // Initial render only: before fetchReply() gives us the fixed message ID,
    // edit the original interaction reply directly. Deliberately do not use
    // InteractionHelper.safeEditReply here because its Unknown Message fallback
    // is a new followUp(), which must never happen for the Builder preview.
    if (typeof interaction?.editReply !== 'function') return false;
    try {
        await interaction.editReply(payload);
        return true;
    } catch (error) {
        if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {
            return markBuilderPreviewUnavailable(state);
        }
        throw error;
    }
}

async function refreshBuilder(interaction, state) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = \`${COLOR_PICKER_URL}/embed-color?session=\${state.colorSessionToken}&color=\${encodeURIComponent(colorToHex(state.sideColor))}\`;
    }

    const payload = {
        embeds: [buildPreviewEmbed(state), buildControlEmbed(state)],
        components: buildControls(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    // Latest-preview-wins, but the queue stores only payloads. Interaction
    // objects are intentionally excluded so a modal/button/editor update can
    // never become a second Discord reply target.
    state.previewEditPending = payload;
    if (state.previewEditRunning) return true;

    state.previewEditRunning = true;
    let result = true;
    try {
        while (state.previewEditPending) {
            const nextPayload = state.previewEditPending;
            state.previewEditPending = null;
            result = await editBuilderPreviewMessage(state, interaction, nextPayload);
            if (!result && state.builderPreviewUnavailable) {
                state.previewEditPending = null;
                break;
            }
        }
    } finally {
        state.previewEditRunning = false;
    }
    return result;
}

async function editContent`);

const dashboardMarker = '            const dashboardMessage = await interaction.fetchReply();';
const dashboardReplacement = `            const dashboardMessage = await interaction.fetchReply();
            state.builderMessageId = dashboardMessage.id;
            state.builderWebhook = interaction.webhook;
            state.builderPreviewUnavailable = false;`;

if (!text.includes(dashboardMarker)) {
  console.error('[EMBED_BUILDER_SINGLE_PREVIEW] dashboard message marker not found');
  process.exit(1);
}
text = text.replace(dashboardMarker, dashboardReplacement);

fs.writeFileSync(path, text, 'utf8');
console.log('[EMBED_BUILDER_SINGLE_PREVIEW] fixed single preview target; follow-up recovery disabled');
