import { SlashCommandBuilder } from 'discord.js';

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
