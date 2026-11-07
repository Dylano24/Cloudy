import { createEmbed } from '../../utils/embeds.js';
import { createButton, getPaginationRow } from '../../utils/components.js';
import { Collection, ActionRowBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { canSeeAllHelpCommands as canSeeAllCommands, getVisibleHelpCommands } from '../../services/helpCommandService.js';

const BACK_BUTTON_ID = "help-back-to-main";
const ALL_COMMANDS_ID = "help-all-commands";
const PAGINATION_PREFIX = "help-page";
const CATEGORY_SELECT_ID = "help-category-select";
const FOOTER_TEXT = "Made with ❤️";
const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;
const REGISTERED_COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;
const registeredCommandCache = new WeakMap();

const CATEGORY_ICONS = {
    Core: "ℹ️",
    Moderation: "🛡️",
    Economy: "💰",
    Music: "🎵",
    Fun: "🎮",
    Leveling: "📊",
    Utility: "🔧",
    Ticket: "🎫",
    Welcome: "👋",
    Giveaway: "🎉",
    Counter: "🔢",
    Tools: "🛠️",
    Search: "🔍",
    "Reaction Roles": "🎭",
    Community: "👥",
    Birthday: "🎂",
    "Join To Create": "🔌",
    Verification: "✅",
    Config: "⚙️",
};

function formatCategoryName(rawCategory) {
    return rawCategory
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildHelpEntries(command, category) {
    const commandData = normalizeCommandData(command);
    if (!commandData?.name) {
        return [];
    }

    const baseName = commandData.name;
    const baseDescription = commandData.description || "No description";
    const options = commandData.options || [];

    const entries = [];

    for (const option of options) {
        if (!option) continue;

        if (option.type === SUBCOMMAND_TYPE) {
            entries.push({
                baseName,
                displayName: `${baseName} ${option.name}`,
                description: option.description || baseDescription,
                category,
            });
            continue;
        }

        if (option.type === SUBCOMMAND_GROUP_TYPE) {
            const nestedOptions = option.options || [];
            for (const nested of nestedOptions) {
                if (nested?.type !== SUBCOMMAND_TYPE) continue;

                entries.push({
                    baseName,
                    displayName: `${baseName} ${option.name} ${nested.name}`,
                    description: nested.description || option.description || baseDescription,
                    category,
                });
            }
        }
    }

    if (entries.length === 0) {
        entries.push({
            baseName,
            displayName: baseName,
            description: baseDescription,
            category,
        });
    }

    return entries;
}

function normalizeCommandData(command) {
    const rawData = command?.data;
    if (!rawData) {
        return null;
    }

    const jsonData = typeof rawData.toJSON === 'function' ? rawData.toJSON() : rawData;
    if (!jsonData?.name) {
        return null;
    }

    return {
        ...jsonData,
        options: Array.isArray(jsonData.options)
            ? jsonData.options.map((option) =>
                  typeof option?.toJSON === 'function' ? option.toJSON() : option,
              )
            : [],
    };
}

async function getRegisteredCommands(client, interaction) {
    const scope = String(interaction?.guildId || 'global');
    const scopes = registeredCommandCache.get(client) || new Map();
    const cached = scopes.get(scope);
    if (cached?.expiresAt > Date.now()) {
        return cached.commands;
    }

    const registeredCommands = new Collection();
    try {
        const manager = interaction?.guild?.commands || client?.application?.commands;
        if (manager?.fetch) {
            const commands = await manager.fetch();
            for (const cmd of commands.values()) {
                registeredCommands.set(cmd.name, cmd);
            }
        }
        scopes.set(scope, {
            commands: registeredCommands,
            expiresAt: Date.now() + REGISTERED_COMMAND_CACHE_TTL_MS,
        });
        registeredCommandCache.set(client, scopes);
    } catch (error) {
        logger.error('Error fetching registered commands:', error);
    }

    return registeredCommands;
}

async function createCategoryCommandsMenu(category, client, interaction = null) {
    const categoryName = formatCategoryName(category);
    const icon = CATEGORY_ICONS[categoryName] || "🔍";

    const categoryCommands = [];

    for (const entry of getVisibleHelpCommands(client, interaction)) {
        if (entry.category === category) categoryCommands.push(...buildHelpEntries(entry.command, categoryName));
    }

    categoryCommands.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const registeredCommands = await getRegisteredCommands(client, interaction);

    const embed = createEmbed({
        title: `${icon} ${categoryName} Commands`,
        description: categoryCommands.length > 0
            ? `Click any command mention below to use it.`
            : `No commands found in the **${categoryName}** category.`
    });

    if (categoryCommands.length > 0) {
        const commandMentions = categoryCommands
            .map((cmd) => {
                const registeredCmd = registeredCommands.get(cmd.baseName);
                if (registeredCmd && registeredCmd.id) {
                    return `</${cmd.displayName}:${registeredCmd.id}> · ${cmd.description}`;
                }
                return `\`/${cmd.displayName}\` · ${cmd.description}`;
            })
            .join("\n");

        const maxLength = 1000;
        if (commandMentions.length <= maxLength) {
            embed.addFields({
                name: "Commands",
                value: commandMentions,
                inline: false,
            });
        } else {
            const chunks = [];
            let currentChunk = "";
            const lines = commandMentions.split("\n");

            for (const line of lines) {
                if ((currentChunk + "\n" + line).length > maxLength) {
                    if (currentChunk) chunks.push(currentChunk);
                    currentChunk = line;
                } else {
                    currentChunk += (currentChunk ? "\n" : "") + line;
                }
            }
            if (currentChunk) chunks.push(currentChunk);

            chunks.forEach((chunk, index) => {
                embed.addFields({
                    name: `Commands (Part ${index + 1})`,
                    value: chunk,
                    inline: false,
                });
            });
        }
    }

    embed.setFooter({ text: FOOTER_TEXT });
    embed.setTimestamp();

    const backButton = createButton(
        BACK_BUTTON_ID,
        "Back",
        "primary",
        "⬅️",
        false,
    );

    const buttonRow = new ActionRowBuilder().addComponents(backButton);

    return {
        embeds: [embed],
        components: [buttonRow],
    };
}

export async function createAllCommandsMenu(page = 1, client, interaction = null) {
    const commandsPerPage = 45;
    const allCommands = [];

    for (const entry of getVisibleHelpCommands(client, interaction)) {
        allCommands.push(...buildHelpEntries(entry.command, formatCategoryName(entry.category)));
    }

    allCommands.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const registeredCommands = await getRegisteredCommands(client, interaction);

    const totalPages = Math.max(1, Math.ceil(allCommands.length / commandsPerPage));
    const startIndex = (page - 1) * commandsPerPage;
    const endIndex = startIndex + commandsPerPage;
    const pageCommands = allCommands.slice(startIndex, endIndex);

    const embed = createEmbed({
        title: "📋 All Commands",
        description: canSeeAllCommands(interaction)
            ? `Browse all Cloudy player and administration commands.`
            : `Browse every command available to Cloudy players.`
    });

    embed.setFooter({ text: FOOTER_TEXT });
    embed.setTimestamp();

    if (pageCommands.length > 0) {
        const commandMentions = pageCommands.map((cmd) => {
            const registeredCmd = registeredCommands.get(cmd.baseName);
            if (registeredCmd && registeredCmd.id) {
                return `</${cmd.displayName}:${registeredCmd.id}> · ${cmd.category}`;
            }
            return `\`/${cmd.displayName}\` · ${cmd.category}`;
        });

        const columnCount = pageCommands.length > 20 ? 3 : (pageCommands.length > 10 ? 2 : 1);
        const chunkSize = Math.ceil(commandMentions.length / columnCount);

        for (let i = 0; i < columnCount; i++) {
            const chunk = commandMentions
                .slice(i * chunkSize, (i + 1) * chunkSize)
                .join("\n");

            if (!chunk) continue;

            embed.addFields({
                name: i === 0 ? `Commands (Page ${page})` : "Commands (cont.)",
                value: chunk,
                inline: columnCount > 1,
            });
        }
    }

    const components = [];

    if (totalPages > 1) {
        const paginationRow = getPaginationRow(
            PAGINATION_PREFIX,
            page,
            totalPages,
        );
        components.push(paginationRow);
    }

    const backButton = createButton(
        BACK_BUTTON_ID,
        "Back",
        "primary",
        "⬅️",
        false,
    );

    const buttonRow = new ActionRowBuilder().addComponents(backButton);
    components.push(buttonRow);

    return {
        embeds: [embed],
        components,
        currentPage: page,
        totalPages,
    };
}

export const helpCategorySelectMenu = {
    name: CATEGORY_SELECT_ID,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const selectedCategory = interaction.values[0];

            if (selectedCategory === ALL_COMMANDS_ID) {
                const { embeds, components } = await createAllCommandsMenu(1, client, interaction);
                await interaction.editReply({
                    embeds,
                    components,
                });
            } else {
                const { embeds, components } = await createCategoryCommandsMenu(selectedCategory, client, interaction);
                await interaction.editReply({
                    embeds,
                    components,
                });
            }
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logger.warn('Help category select interaction already acknowledged or expired.', {
                    event: 'interaction.help.select.unavailable',
                    errorCode: String(error.code),
                    customId: interaction.customId,
                    interactionId: interaction.id,
                });
                return;
            }

            await handleInteractionError(interaction, error, {
                type: 'select_menu',
                customId: interaction.customId,
                handler: 'help_category',
            });
        }
    },
};
