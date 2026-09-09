import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SlashCommandBuilder } from 'discord.js';

const SOURCE_PATCH_SENTINEL = "const pendingSearchKey = String(interaction.guildId || interaction.guild?.id || 'dm')";

function patchEmbedBuilderSearchPreviewSource() {
    try {
        const embedBuilderPath = fileURLToPath(new URL('./embedbuilder.js', import.meta.url));
        let source = fs.readFileSync(embedBuilderPath, 'utf8');
        if (source.includes(SOURCE_PATCH_SENTINEL)) return;

        const replacements = [
            [
                "import { CLOUDY_LOGO_URL, isCloudyLogoUrl } from '../../services/cloudyLogoService.js';",
                "import { CLOUDY_LOGO_URL, isCloudyLogoUrl, migrateCloudyLogoEmbedData } from '../../services/cloudyLogoService.js';",
            ],
            [
                "import { openEmbedManager, saveModifiedEmbed } from '../../services/embedManagerService.js';",
                "import { openEmbedManager, saveModifiedEmbed, templateIdentity } from '../../services/embedManagerService.js';",
            ],
            [
                "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';",
                "import { getEmbedRegistrySnapshot, registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';",
            ],
            [
                `            const state = {
                title: null,
                message: null,
                embedFields: [],
                sideColor: 0xFFFFFF,
                showLogo: true,
                removeExistingLogo: false,
                bottomLine: DEFAULT_FOOTER_TEXT,
                mediaUrl: null,
                mediaBuffer: null,
                mediaName: null,
                mediaConvertedFromVideo: false,
                modifyTarget: null,
                colorSessionToken: null,
            };

            const guildEmojis = interaction.guild`,
                `            const state = {
                title: null,
                message: null,
                embedFields: [],
                sideColor: 0xFFFFFF,
                showLogo: true,
                removeExistingLogo: false,
                bottomLine: DEFAULT_FOOTER_TEXT,
                mediaUrl: null,
                mediaBuffer: null,
                mediaName: null,
                mediaConvertedFromVideo: false,
                modifyTarget: null,
                colorSessionToken: null,
            };

            // A selected /embedbuilder search result must behave exactly like a
            // normal Modify selection: load the real embed state before the first
            // builder render so the live preview and Save target are immediately correct.
            const pendingSearchKey = String(interaction.guildId || interaction.guild?.id || 'dm')
                + ':' + String(interaction.user?.id || 'unknown');
            const pendingSearch = globalThis.__cloudyEmbedBuilderSearchSelections?.get?.(pendingSearchKey) || null;
            const pendingRecord = pendingSearch?.record || null;
            if (pendingRecord && interaction.guild) {
                const snapshot = getEmbedRegistrySnapshot(pendingRecord);
                if (snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length) {
                    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
                    const rawFooter = String(data.footer?.text || '');
                    const footerText = rawFooter.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)
                        ? rawFooter.slice(0, -MESSAGE_BUILDER_FOOTER_MARKER.length)
                        : rawFooter;
                    const logicalChannelId = String(pendingRecord.channelId || '');
                    const backingChannelId = String(pendingRecord.backingChannelId || pendingRecord.channelId || '');

                    state.title = data.title || null;
                    state.message = data.description || null;
                    state.embedFields = Array.isArray(data.fields)
                        ? data.fields.map(field => ({
                            name: String(field.name || '').slice(0, 256),
                            value: String(field.value || '').slice(0, 1024),
                            inline: Boolean(field.inline),
                        }))
                        : [];
                    state.sideColor = Number.isInteger(data.color) ? data.color : 0xFFFFFF;
                    state.showLogo = isCloudyLogoUrl(data.thumbnail?.url);
                    state.removeExistingLogo = false;
                    state.bottomLine = footerText || null;
                    state.mediaUrl = data.image?.url || null;
                    state.mediaBuffer = null;
                    state.mediaName = null;
                    state.mediaConvertedFromVideo = false;
                    state.modifyTarget = {
                        guildId: interaction.guild.id,
                        channelId: logicalChannelId,
                        backingChannelId,
                        messageId: String(pendingRecord.messageId),
                        embedIndex: Number(pendingRecord.embedIndex || 0),
                        source: pendingRecord.source || 'cloudy',
                        sourceEmbedData: data,
                        hadBuilderMarker: rawFooter.endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
                        templateMode: String(pendingRecord.source || '').toLowerCase() !== 'embed-builder',
                        templateTitle: templateIdentity(logicalChannelId, data),
                        cachedMessage: null,
                    };

                    globalThis.__cloudyEmbedBuilderSearchSelections?.delete?.(pendingSearchKey);
                }
            }

            const guildEmojis = interaction.guild`,
            ],
        ];

        if (!replacements.every(([before]) => source.includes(before))) {
            console.warn('[EMBED_BUILDER] Search live-preview source patch skipped because the builder source changed.');
            return;
        }

        for (const [before, after] of replacements) source = source.replace(before, after);
        fs.writeFileSync(embedBuilderPath, source, 'utf8');
        console.info('[EMBED_BUILDER] Search live-preview source patch applied.');
    } catch (error) {
        console.error('[EMBED_BUILDER] Search live-preview source patch failed:', error);
    }
}

patchEmbedBuilderSearchPreviewSource();

const PATCH_MARKER = Symbol.for('cloudy.embedbuilderLiveSearchSchema');
const prototype = SlashCommandBuilder.prototype;

if (!prototype[PATCH_MARKER]) {
    const originalSetDefaultMemberPermissions = prototype.setDefaultMemberPermissions;

    prototype.setDefaultMemberPermissions = function patchedSetDefaultMemberPermissions(...args) {
        const result = originalSetDefaultMemberPermissions.apply(this, args);

        if (
            String(this.name || '').toLowerCase() === 'embedbuilder'
            && !this.options?.some(option => option?.name === 'search')
        ) {
            this.addStringOption(option => option
                .setName('search')
                .setDescription('Search all Cloudy embeds and bot templates')
                .setAutocomplete(true)
                .setRequired(false));
        }

        return result;
    };

    Object.defineProperty(prototype, PATCH_MARKER, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

export default {};
