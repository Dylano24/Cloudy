import { createEmbed } from '../../utils/embeds.js';
import { createButton, getPaginationRow } from '../../utils/components.js';
import { ActionRowBuilder, Collection, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { isPlayerCommand } from '../../config/playerCommands.js';
import { isBotOwner } from '../../config/bot.js';

const BACK_BUTTON_ID = 'help-back-to-main';
const ALL_COMMANDS_ID = 'help-all-commands';
const PAGINATION_PREFIX = 'help-page';
const CATEGORY_SELECT_ID = 'help-category-select';
const FOOTER_TEXT = 'Made with ❤️';
const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;

const CATEGORY_ICONS = {
  Core: 'ℹ️',
  Moderation: '🛡️',
  Economy: '💰',
  Music: '🎵',
  Fun: '🎮',
  Leveling: '📊',
  Utility: '🔧',
  Ticket: '🎫',
  Welcome: '👋',
  Giveaway: '🎉',
  Counter: '🔢',
  Tools: '🛠️',
  Search: '🔍',
  'Reaction Roles': '🎭',
  Community: '👥',
  Birthday: '🎂',
  'Join To Create': '🔌',
  Verification: '✅',
  Config: '⚙️',
};

function canSeeAllCommands(interaction) {
  return Boolean(
    isBotOwner(interaction?.user?.id)
    || interaction?.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

function formatCategoryName(rawCategory) {
  return String(rawCategory || 'Core')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeCommandData(command) {
  const rawData = command?.data;
  if (!rawData) return null;
  const jsonData = typeof rawData.toJSON === 'function' ? rawData.toJSON() : rawData;
  if (!jsonData?.name) return null;
  return {
    ...jsonData,
    options: Array.isArray(jsonData.options)
      ? jsonData.options.map((option) => (
          typeof option?.toJSON === 'function' ? option.toJSON() : option
        ))
      : [],
  };
}

function buildHelpEntries(command, category) {
  const commandData = normalizeCommandData(command);
  if (!commandData?.name) return [];

  const baseName = commandData.name;
  const baseDescription = commandData.description || 'No description';
  const entries = [];

  for (const option of commandData.options || []) {
    if (option?.type === SUBCOMMAND_TYPE) {
      entries.push({
        baseName,
        displayName: `${baseName} ${option.name}`,
        description: option.description || baseDescription,
        category,
      });
      continue;
    }

    if (option?.type === SUBCOMMAND_GROUP_TYPE) {
      for (const nested of option.options || []) {
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

  if (!entries.length) {
    entries.push({ baseName, displayName: baseName, description: baseDescription, category });
  }

  return entries;
}

function getVisibleLoadedCommands(client, interaction, categoryFilter = null) {
  const showAll = canSeeAllCommands(interaction);
  const entries = [];

  for (const command of client.commands.values()) {
    const data = normalizeCommandData(command);
    if (!data?.name || data.name === 'help') continue;
    if (!showAll && !isPlayerCommand(data.name)) continue;

    const categoryName = formatCategoryName(command.category || 'Core');
    if (categoryFilter && categoryName !== formatCategoryName(categoryFilter)) continue;
    entries.push(...buildHelpEntries(command, categoryName));
  }

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

async function fetchRegisteredGuildCommands(client, interaction) {
  const registered = new Collection();
  try {
    const guildCommands = interaction?.guild?.commands;
    if (guildCommands?.fetch) {
      const commands = await guildCommands.fetch();
      for (const command of commands.values()) registered.set(command.name, command);
      return registered;
    }

    const guild = client.guilds.cache.first();
    if (guild?.commands?.fetch) {
      const commands = await guild.commands.fetch();
      for (const command of commands.values()) registered.set(command.name, command);
    }
  } catch (error) {
    logger.error('Error fetching registered guild commands for help:', error);
  }
  return registered;
}

function filterToRegistered(entries, registeredCommands) {
  if (!registeredCommands?.size) return entries;
  return entries.filter((entry) => registeredCommands.has(entry.baseName));
}

function makeCommandLine(entry, registeredCommands, includeDescription = true) {
  const registered = registeredCommands.get(entry.baseName);
  const commandText = registered?.id
    ? `</${entry.displayName}:${registered.id}>`
    : `\`/${entry.displayName}\``;
  return includeDescription ? `${commandText} · ${entry.description}` : `${commandText} · ${entry.category}`;
}

async function createCategoryCommandsMenu(category, client, interaction = null) {
  const categoryName = formatCategoryName(category);
  const icon = CATEGORY_ICONS[categoryName] || '🔍';
  const registeredCommands = await fetchRegisteredGuildCommands(client, interaction);
  const categoryCommands = filterToRegistered(
    getVisibleLoadedCommands(client, interaction, categoryName),
    registeredCommands,
  );

  const embed = createEmbed({
    title: `${icon} ${categoryName} Commands`,
    description: categoryCommands.length
      ? 'Every command shown below is loaded and registered in this server.'
      : `No registered commands found in the **${categoryName}** category.`,
  });

  if (categoryCommands.length) {
    const lines = categoryCommands.map((entry) => makeCommandLine(entry, registeredCommands, true));
    const chunks = [];
    let current = '';
    for (const line of lines) {
      if (`${current}\n${line}`.length > 1000) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current += `${current ? '\n' : ''}${line}`;
      }
    }
    if (current) chunks.push(current);

    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: chunks.length === 1 ? 'Commands' : `Commands (Part ${index + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }

  embed.setFooter({ text: FOOTER_TEXT });
  embed.setTimestamp();

  const backButton = createButton(BACK_BUTTON_ID, 'Back', 'primary', '⬅️', false);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(backButton)] };
}

export async function createAllCommandsMenu(page = 1, client, interaction = null) {
  const commandsPerPage = 45;
  const registeredCommands = await fetchRegisteredGuildCommands(client, interaction);
  const allCommands = filterToRegistered(
    getVisibleLoadedCommands(client, interaction),
    registeredCommands,
  );

  const totalPages = Math.max(1, Math.ceil(allCommands.length / commandsPerPage));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const startIndex = (safePage - 1) * commandsPerPage;
  const pageCommands = allCommands.slice(startIndex, startIndex + commandsPerPage);

  const embed = createEmbed({
    title: '📋 All Commands',
    description: canSeeAllCommands(interaction)
      ? 'Only commands currently loaded and registered in this server are shown.'
      : 'Only player commands currently loaded and registered in this server are shown.',
  });
  embed.setFooter({ text: FOOTER_TEXT });
  embed.setTimestamp();

  if (pageCommands.length) {
    const commandMentions = pageCommands.map((entry) => makeCommandLine(entry, registeredCommands, false));
    const columnCount = pageCommands.length > 20 ? 3 : (pageCommands.length > 10 ? 2 : 1);
    const chunkSize = Math.ceil(commandMentions.length / columnCount);

    for (let i = 0; i < columnCount; i += 1) {
      const chunk = commandMentions.slice(i * chunkSize, (i + 1) * chunkSize).join('\n');
      if (!chunk) continue;
      embed.addFields({
        name: i === 0 ? `Commands (Page ${safePage})` : 'Commands (cont.)',
        value: chunk,
        inline: columnCount > 1,
      });
    }
  }

  const components = [];
  if (totalPages > 1) components.push(getPaginationRow(PAGINATION_PREFIX, safePage, totalPages));
  components.push(new ActionRowBuilder().addComponents(
    createButton(BACK_BUTTON_ID, 'Back', 'primary', '⬅️', false),
  ));

  return { embeds: [embed], components, currentPage: safePage, totalPages };
}

export const helpCategorySelectMenu = {
  name: CATEGORY_SELECT_ID,
  async execute(interaction, client) {
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const selectedCategory = interaction.values[0];
      const view = selectedCategory === ALL_COMMANDS_ID
        ? await createAllCommandsMenu(1, client, interaction)
        : await createCategoryCommandsMenu(selectedCategory, client, interaction);
      await interaction.editReply({ embeds: view.embeds, components: view.components });
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
