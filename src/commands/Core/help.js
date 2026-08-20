import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { createSelectMenu } from '../../utils/components.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const CATEGORY_SELECT_ID = 'help-category-select';
const ALL_COMMANDS_ID = 'help-all-commands';
const HELP_MENU_TIMEOUT_MS = 5 * 60 * 1000;

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
};

function formatCategoryName(rawCategory) {
  return String(rawCategory || 'Core')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getVisibleCategories(client, showAllCommands) {
  const categories = new Set();
  for (const command of client.commands.values()) {
    const commandName = String(command?.data?.name || '').toLowerCase();
    if (!commandName || commandName === 'help') continue;
    if (!showAllCommands && !isPlayerCommand(commandName)) continue;
    categories.add(command.category || 'Core');
  }
  return [...categories].sort((a, b) => formatCategoryName(a).localeCompare(formatCategoryName(b)));
}

export async function createInitialHelpMenu(client, interaction = null) {
  const showAllCommands = Boolean(
    isBotOwner(interaction?.user?.id)
    || interaction?.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );

  const categoryDirs = getVisibleCategories(client, showAllCommands);
  const options = [
    ...(showAllCommands ? [{
      label: '📋 All Commands',
      description: 'Browse every currently registered command',
      value: ALL_COMMANDS_ID,
    }] : []),
    ...categoryDirs.map((category) => {
      const categoryName = formatCategoryName(category);
      const icon = CATEGORY_ICONS[categoryName] || '🔍';
      return {
        label: `${icon} ${categoryName}`,
        description: `View registered commands in ${categoryName}`,
        value: category,
      };
    }),
  ].slice(0, 25);

  const botName = client?.user?.username || 'Bot';
  const embed = createEmbed({
    title: `📖 ${botName} Help`,
    description: showAllCommands
      ? 'Browse the commands Cloudy has actually loaded for this server.'
      : 'Browse the player commands Cloudy has actually loaded for this server.',
    color: 'primary',
    thumbnail: client.user?.displayAvatarURL?.({ size: 1024 }),
    fields: [showAllCommands ? {
      name: '👑 All Commands',
      value: 'The menu only shows commands that exist in the active runtime; old or grouped implementation files are excluded.',
      inline: false,
    } : {
      name: '🎮 Member Commands',
      value: '• Economy & shop\n• Fun & utility\n• Music\n• Rank & leaderboard\n• Weather & search\n• Support & verification',
      inline: false,
    }],
  });

  embed.setFooter({ text: 'Made with ❤️' });
  embed.setTimestamp();

  const selectRow = createSelectMenu(
    CATEGORY_SELECT_ID,
    'Select to view the commands',
    options,
  );

  return { embeds: [embed], components: [selectRow] };
}

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays the help menu with all available commands'),

  async execute(interaction, guildConfig, client) {
    await InteractionHelper.safeDefer(interaction);
    const { embeds, components } = await createInitialHelpMenu(client, interaction);

    await InteractionHelper.safeEditReply(interaction, { embeds, components });

    setTimeout(async () => {
      try {
        if (!InteractionHelper.isInteractionValid(interaction)) return;
        const closedEmbed = createEmbed({
          title: 'Help menu closed',
          description: 'Help menu has been closed, use /help again.',
          color: 'secondary',
        });
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [closedEmbed],
          components: [],
        });
      } catch (error) {
        logger.debug('Help menu close edit failed (interaction may have expired):', error?.message);
      }
    }, HELP_MENU_TIMEOUT_MS);
  },
};
