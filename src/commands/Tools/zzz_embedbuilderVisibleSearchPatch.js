import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import embedBuilderCommand from './embedbuilder.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const PATCH = Symbol.for('cloudy.embedbuilderVisibleSearch');
const RESPONSE_PATCH = Symbol.for('cloudy.embedbuilderVisibleSearchResponses');
const SEARCH_BUTTON_ID = 'simple_embed_live_search';

function componentId(component) {
    const data = component?.toJSON ? component.toJSON() : component?.data || component;
    return String(data?.custom_id || data?.customId || '');
}

function isBuilderPayload(payload) {
    return (payload?.embeds || []).some(embed => {
        const data = embed?.toJSON ? embed.toJSON() : embed;
        return String(data?.title || '').trim().toLowerCase() === 'message builder';
    });
}

function addVisibleSearchButton(payload) {
    if (!payload || typeof payload !== 'object' || !isBuilderPayload(payload)) return payload;

    const rows = Array.isArray(payload.components) ? [...payload.components] : [];
    const alreadyPresent = rows.some(row => {
        const data = row?.toJSON ? row.toJSON() : row;
        return (data?.components || []).some(component => componentId(component) === SEARCH_BUTTON_ID);
    });
    if (alreadyPresent) return payload;

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(SEARCH_BUTTON_ID)
            .setLabel('Search embeds')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔎'),
    ));

    return { ...payload, components: rows };
}

function patchResponses() {
    if (InteractionHelper[RESPONSE_PATCH]) return;

    const previous = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
    InteractionHelper.patchInteractionResponses = function patchVisibleSearch(interaction) {
        previous(interaction);
        if (!interaction || interaction.__cloudyVisibleSearchResponses) return;

        for (const method of ['reply', 'editReply', 'followUp', 'update']) {
            const original = interaction[method]?.bind(interaction);
            if (!original) continue;
            interaction[method] = async (payload, ...args) => original(addVisibleSearchButton(payload), ...args);
        }

        interaction.__cloudyVisibleSearchResponses = true;
    };

    Object.defineProperty(InteractionHelper, RESPONSE_PATCH, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

if (!embedBuilderCommand[PATCH]) {
    patchResponses();

    const originalExecute = embedBuilderCommand.execute.bind(embedBuilderCommand);
    embedBuilderCommand.execute = async function executeWithVisibleSearch(interaction, ...args) {
        const originalFetchReply = interaction.fetchReply?.bind(interaction);
        if (originalFetchReply && !interaction.__cloudyVisibleSearchCollectorPatch) {
            interaction.fetchReply = async (...fetchArgs) => {
                const message = await originalFetchReply(...fetchArgs);
                if (!message || message.__cloudyVisibleSearchCollectorPatch) return message;

                const originalCreateCollector = message.createMessageComponentCollector?.bind(message);
                if (originalCreateCollector) {
                    message.createMessageComponentCollector = options => {
                        const collector = originalCreateCollector(options);
                        const originalOn = collector.on.bind(collector);
                        collector.on = (event, listener) => {
                            if (event !== 'collect') return originalOn(event, listener);
                            return originalOn(event, async componentInteraction => {
                                if (componentInteraction?.customId === SEARCH_BUTTON_ID) {
                                    const searchMessage = await componentInteraction.reply({
                                        embeds: [new EmbedBuilder()
                                            .setTitle('Search embeds')
                                            .setDescription([
                                                'Use the **search** field on `/embedbuilder` and start typing.',
                                                '',
                                                'Results update live for every letter and are ranked by title/name relevance. Bot code templates are shown independently from channels and alphabetically when no search text is entered.',
                                            ].join('\n'))
                                            .setColor(0xFFFFFF)],
                                        flags: MessageFlags.Ephemeral,
                                        fetchReply: true,
                                    }).catch(() => null);

                                    if (searchMessage) {
                                        const timer = setTimeout(() => {
                                            componentInteraction.webhook?.deleteMessage?.(searchMessage.id).catch(() => {});
                                        }, 10_000);
                                        timer.unref?.();
                                    }
                                    return;
                                }
                                return listener(componentInteraction);
                            });
                        };
                        return collector;
                    };
                }

                Object.defineProperty(message, '__cloudyVisibleSearchCollectorPatch', {
                    value: true,
                    configurable: false,
                    enumerable: false,
                    writable: false,
                });
                return message;
            };
            interaction.__cloudyVisibleSearchCollectorPatch = true;
        }

        return originalExecute(interaction, ...args);
    };

    Object.defineProperty(embedBuilderCommand, PATCH, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

export default {};
