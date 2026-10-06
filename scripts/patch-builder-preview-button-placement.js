import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'BUILDER_PREVIEW_BUTTON_PLACEMENT_V1';
const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

if (before.includes(marker)) {
  console.log('[BUILDER_PREVIEW_PLACEMENT] already current');
  process.exit(0);
}

let text = before;

// Work on the final Builder shape after the professional button patch.
// Live custom buttons belong to the top preview message, never the dashboard.
const controlsStart = text.indexOf('function buildControls(state) {');
const controlsEnd = text.indexOf('\n}\n\nfunction getPreviewUpdateQueue', controlsStart);
if (controlsStart < 0 || controlsEnd < 0) {
  console.warn('[BUILDER_PREVIEW_PLACEMENT] buildControls shape not found; leaving runtime unchanged');
  process.exit(0);
}

let controls = text.slice(controlsStart, controlsEnd + 2);
controls = controls.replace(
  /\n {4}const buttonPreviewComponents = getBuilderMessageComponents\(state\)[\s\S]*? {4}const previewRows = buttonPreviewComponents\.length\n {8}\? \[\{ type: 1, components: buttonPreviewComponents \}\]\n {8}: \[\];\n/,
  '\n',
);
controls = controls.replace(
  '    return [...previewRows, titleRow, contentRow, editRow, saveRow].slice(0, 5);',
  '    return [titleRow, contentRow, editRow, saveRow];',
);

if (controls.includes('previewRows') || controls.includes('buttonPreviewComponents')) {
  console.warn('[BUILDER_PREVIEW_PLACEMENT] preview-row cleanup did not match; leaving runtime unchanged');
  process.exit(0);
}

text = text.slice(0, controlsStart) + controls + text.slice(controlsEnd + 2);

// Split live preview and dashboard updates. Discord renders components below
// every embed in one message, so two messages are required for this layout.
const refreshStart = text.indexOf('async function refreshBuilder(interaction, state) {');
const refreshEnd = text.indexOf('\n\nasync function editContent', refreshStart);
if (refreshStart < 0 || refreshEnd < 0) {
  console.warn('[BUILDER_PREVIEW_PLACEMENT] refreshBuilder shape not found; leaving runtime unchanged');
  process.exit(0);
}

const refreshReplacement = `async function editBuilderDashboardMessage(state, payload) {
    if (!state.builderDashboardMessageId) return true;

    if (state.builderDashboardMessage?.edit) {
        try {
            touchBuilderSessionMessage(state.builderDashboardMessage);
            const edited = await state.builderDashboardMessage.edit(payload);
            if (edited) state.builderDashboardMessage = edited;
            return true;
        } catch {}
    }

    if (state.builderDashboardWebhook?.editMessage) {
        try {
            const edited = await state.builderDashboardWebhook.editMessage(
                String(state.builderDashboardMessageId),
                payload,
            );
            if (edited) state.builderDashboardMessage = edited;
            return true;
        } catch {}
    }

    return false;
}

async function deleteBuilderDashboardMessage(state) {
    const id = state.builderDashboardMessageId
        ? String(state.builderDashboardMessageId)
        : null;
    const message = state.builderDashboardMessage || null;
    const webhook = state.builderDashboardWebhook || null;

    state.builderDashboardMessage = null;
    state.builderDashboardMessageId = null;
    state.builderDashboardWebhook = null;

    if (message?.delete) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) return true;
    }
    if (id && webhook?.deleteMessage) {
        return webhook.deleteMessage(id).then(() => true).catch(() => false);
    }
    return false;
}

// BUILDER_PREVIEW_BUTTON_PLACEMENT_V1
async function refreshBuilder(interaction, state) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = \`\${COLOR_PICKER_URL}/embed-color?session=\${state.colorSessionToken}&color=\${encodeURIComponent(colorToHex(state.sideColor))}\`;
    }

    const previewPayload = {
        embeds: [buildPreviewEmbed(state)],
        components: getBuilderPreviewComponents(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        previewPayload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    const dashboardPayload = {
        embeds: [buildControlEmbed(state)],
        components: buildControls(state),
    };

    state.previewEditPending = { previewPayload, dashboardPayload };
    if (state.previewEditRunning) return true;

    state.previewEditRunning = true;
    let result = true;
    try {
        while (state.previewEditPending) {
            const next = state.previewEditPending;
            state.previewEditPending = null;

            const previewUpdated = await editBuilderPreviewMessage(
                state,
                interaction,
                next.previewPayload,
            );

            const dashboardUpdated = state.builderDashboardMessageId
                ? await editBuilderDashboardMessage(state, next.dashboardPayload)
                : true;

            result = previewUpdated && dashboardUpdated;
            if (!previewUpdated && state.builderPreviewUnavailable) {
                state.previewEditPending = null;
                break;
            }
        }
    } finally {
        state.previewEditRunning = false;
    }
    return result;
}`;

text = text.slice(0, refreshStart) + refreshReplacement + text.slice(refreshEnd);

// First response = preview only.
const initialStart = text.indexOf('            const initialShown = await InteractionHelper.safeReply(interaction, {');
const initialEndMarker = '            if (!initialShown) return;';
const initialEnd = text.indexOf(initialEndMarker, initialStart);
if (initialStart < 0 || initialEnd < 0) {
  console.warn('[BUILDER_PREVIEW_PLACEMENT] initial reply shape not found; leaving runtime unchanged');
  process.exit(0);
}

const initialReplacement = `            const initialShown = await InteractionHelper.safeReply(interaction, {
                embeds: [buildPreviewEmbed(state)],
                components: getBuilderPreviewComponents(state),
                ...(builderBotManaged ? {} : { flags: MessageFlags.Ephemeral }),
            });
            if (!initialShown) return;`;
text = text.slice(0, initialStart)
  + initialReplacement
  + text.slice(initialEnd + initialEndMarker.length);

// Second response = Message builder dashboard and controls.
const dashboardStart = text.indexOf('            const dashboardMessage = await interaction.fetchReply();');
const collectorStart = text.indexOf('            const collector = dashboardMessage.createMessageComponentCollector({', dashboardStart);
if (dashboardStart < 0 || collectorStart < 0) {
  console.warn('[BUILDER_PREVIEW_PLACEMENT] dashboard collector shape not found; leaving runtime unchanged');
  process.exit(0);
}

const dashboardReplacement = `            // Start both post-reply network operations together so the
            // dashboard appears with the preview instead of one round-trip later.
            const dashboardPromise = interaction.followUp({
                embeds: [buildControlEmbed(state)],
                components: buildControls(state),
                ...(builderBotManaged ? {} : { flags: MessageFlags.Ephemeral }),
                fetchReply: true,
            }).catch(() => null);
            const [previewMessage, dashboardMessage] = await Promise.all([
                interaction.fetchReply().catch(() => null),
                dashboardPromise,
            ]);

            if (!previewMessage || !dashboardMessage) {
                await interaction.deleteReply().catch(() => {});
                await dashboardMessage?.delete?.().catch(() => {});
                return;
            }

            state.builderMessage = previewMessage;
            state.builderMessageId = previewMessage.id;
            state.builderWebhook = interaction.webhook;
            state.builderPreviewUnavailable = false;

            state.builderDashboardMessage = dashboardMessage;
            state.builderDashboardMessageId = dashboardMessage.id;
            state.builderDashboardWebhook = interaction.webhook;
`;
text = text.slice(0, dashboardStart)
  + dashboardReplacement
  + text.slice(collectorStart);

// Closing removes lower dashboard as well.
const closeStart = text.indexOf("case 'simple_embed_close':");
if (closeStart >= 0) {
  const closeEnd = text.indexOf("\n                        case '", closeStart + 8);
  let closeBlock = text.slice(closeStart, closeEnd >= 0 ? closeEnd : text.length);
  if (!closeBlock.includes('deleteBuilderDashboardMessage(state)')) {
    const deferNeedle = 'await buttonInteraction.deferUpdate().catch(() => {});';
    if (closeBlock.includes(deferNeedle)) {
      closeBlock = closeBlock.replace(
        deferNeedle,
        deferNeedle + '\n                            await deleteBuilderDashboardMessage(state).catch(() => {});',
      );
      text = text.slice(0, closeStart)
        + closeBlock
        + text.slice(closeEnd >= 0 ? closeEnd : text.length);
    }
  }
}

fs.writeFileSync(path, text, 'utf8');
console.log('[BUILDER_PREVIEW_PLACEMENT] existing/custom buttons render disabled under the top preview, not under Message builder.');
