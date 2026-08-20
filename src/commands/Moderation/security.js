import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  DEFAULT_SECURITY_CONFIG,
  SECURITY_ACTIONS,
  getSecurityConfig,
  saveSecurityConfig,
  getQuarantineRecords,
  releaseQuarantine,
  createSecurityBackup,
  getSecurityBackups,
  restoreSecurityBackup,
} from '../../services/securityService.js';

function actionChoices(option) {
  return option.addChoices(
    ...SECURITY_ACTIONS.map((action) => ({
      name: action.charAt(0).toUpperCase() + action.slice(1),
      value: action,
    })),
  );
}

function onOff(value) {
  return value ? '✅ On' : '❌ Off';
}

const data = new SlashCommandBuilder()
  .setName('security')
  .setDescription('Configure Cloudy anti-nuke, Join Gate, anti-spam and backups')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName('status').setDescription('Show Cloudy security status'))
  .addSubcommand((sub) =>
    sub
      .setName('log-channel')
      .setDescription('Set the security alert channel')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Security log channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('panic')
      .setDescription('Enable or disable panic mode for new joins')
      .addBooleanOption((option) =>
        option.setName('enabled').setDescription('Panic mode state').setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('antinuke')
      .setDescription('Anti-nuke settings')
      .addSubcommand((sub) =>
        sub
          .setName('enabled')
          .setDescription('Enable or disable anti-nuke monitoring')
          .addBooleanOption((option) =>
            option.setName('value').setDescription('Enabled').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('action')
          .setDescription('Set response when an anti-nuke threshold is reached')
          .addStringOption((option) =>
            actionChoices(
              option.setName('action').setDescription('Response').setRequired(true),
            ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('limits')
          .setDescription('Set anti-nuke action limits')
          .addIntegerOption((option) =>
            option.setName('per_minute').setDescription('Allowed actions per minute').setMinValue(1).setMaxValue(100).setRequired(true),
          )
          .addIntegerOption((option) =>
            option.setName('per_hour').setDescription('Allowed actions per hour').setMinValue(1).setMaxValue(500).setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('joingate')
      .setDescription('Join Gate settings')
      .addSubcommand((sub) =>
        sub
          .setName('enabled')
          .setDescription('Enable or disable Join Gate')
          .addBooleanOption((option) => option.setName('value').setDescription('Enabled').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('action')
          .setDescription('Set Join Gate response')
          .addStringOption((option) =>
            actionChoices(option.setName('action').setDescription('Response').setRequired(true)),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('account-age')
          .setDescription('Require accounts to be at least this old')
          .addIntegerOption((option) =>
            option.setName('days').setDescription('Minimum age in days; 0 disables').setMinValue(0).setMaxValue(3650).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('filters')
          .setDescription('Configure Join Gate account filters')
          .addBooleanOption((option) => option.setName('no_avatar').setDescription('Flag accounts without a custom avatar'))
          .addBooleanOption((option) => option.setName('unauthorized_bots').setDescription('Flag bots added by untrusted users'))
          .addBooleanOption((option) => option.setName('unverified_bots').setDescription('Flag Discord-unverified bots'))
          .addBooleanOption((option) => option.setName('advertising_names').setDescription('Flag advertising/invite-style names')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('name-pattern')
          .setDescription('Add a blocked username regex/text pattern')
          .addStringOption((option) =>
            option.setName('pattern').setDescription('Regex or text pattern').setMaxLength(100).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('clear-patterns').setDescription('Clear custom blocked username patterns'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('antispam')
      .setDescription('Anti-spam/heat settings')
      .addSubcommand((sub) =>
        sub
          .setName('enabled')
          .setDescription('Enable or disable anti-spam')
          .addBooleanOption((option) => option.setName('value').setDescription('Enabled').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('action')
          .setDescription('Set anti-spam response')
          .addStringOption((option) =>
            actionChoices(option.setName('action').setDescription('Response').setRequired(true)),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('limits')
          .setDescription('Set anti-spam heat limits')
          .addIntegerOption((option) => option.setName('window_seconds').setDescription('Rate window').setMinValue(2).setMaxValue(60))
          .addIntegerOption((option) => option.setName('messages').setDescription('Messages in the window').setMinValue(3).setMaxValue(50))
          .addIntegerOption((option) => option.setName('duplicates').setDescription('Duplicate message limit').setMinValue(2).setMaxValue(20))
          .addIntegerOption((option) => option.setName('mentions').setDescription('Mention limit per message').setMinValue(2).setMaxValue(50))
          .addIntegerOption((option) => option.setName('caps_percent').setDescription('Caps percentage threshold').setMinValue(50).setMaxValue(100))
          .addIntegerOption((option) => option.setName('timeout_minutes').setDescription('Timeout duration').setMinValue(1).setMaxValue(10080)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('trust')
      .setDescription('Anti-nuke trusted users and roles')
      .addSubcommand((sub) =>
        sub
          .setName('user-add')
          .setDescription('Trust a user for anti-nuke/Join Gate bot additions')
          .addUserOption((option) => option.setName('user').setDescription('User to trust').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('user-remove')
          .setDescription('Remove a trusted user')
          .addUserOption((option) => option.setName('user').setDescription('User to remove').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('role-add')
          .setDescription('Trust a role')
          .addRoleOption((option) => option.setName('role').setDescription('Role to trust').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('role-remove')
          .setDescription('Remove a trusted role')
          .addRoleOption((option) => option.setName('role').setDescription('Role to remove').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List trusted users and roles')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('quarantine')
      .setDescription('Manage anti-nuke quarantine')
      .addSubcommand((sub) => sub.setName('list').setDescription('List quarantined users'))
      .addSubcommand((sub) =>
        sub
          .setName('release')
          .setDescription('Release a quarantined user and restore saved roles')
          .addUserOption((option) => option.setName('user').setDescription('User to release').setRequired(true)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('backup')
      .setDescription('Security backup snapshots')
      .addSubcommand((sub) => sub.setName('create').setDescription('Save a roles/channels security snapshot'))
      .addSubcommand((sub) => sub.setName('list').setDescription('List security snapshots'))
      .addSubcommand((sub) =>
        sub
          .setName('restore')
          .setDescription('Conservatively recreate missing roles/channels from a snapshot')
          .addStringOption((option) => option.setName('id').setDescription('Backup ID').setRequired(true)),
      ),
  );

export default {
  category: 'Moderation',
  data,

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    try {
      let current = await getSecurityConfig(client, interaction.guildId);

      if (!group && sub === 'status') {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setTitle('🛡️ Cloudy Security')
              .setDescription(
                `**Panic Mode:** ${onOff(current.panic)}\n` +
                `**Security Logs:** ${current.logChannelId ? `<#${current.logChannelId}>` : 'System channel / not configured'}\n\n` +
                `**Anti-Nuke:** ${onOff(current.antiNuke.enabled)} • ${current.antiNuke.action}\n` +
                `Limits: ${current.antiNuke.minuteLimit}/min • ${current.antiNuke.hourLimit}/hour\n\n` +
                `**Join Gate:** ${onOff(current.joinGate.enabled)} • ${current.joinGate.action}\n` +
                `Account age: ${current.joinGate.minimumAccountAgeDays}d • No avatar: ${onOff(current.joinGate.noAvatar)}\n` +
                `Unauthorized bots: ${onOff(current.joinGate.unauthorizedBots)} • Unverified bots: ${onOff(current.joinGate.unverifiedBots)}\n` +
                `Advertising names: ${onOff(current.joinGate.advertisingNames)}\n\n` +
                `**Anti-Spam:** ${onOff(current.antiSpam.enabled)} • ${current.antiSpam.action}\n` +
                `${current.antiSpam.messageLimit} msgs/${current.antiSpam.windowSeconds}s • ${current.antiSpam.duplicateLimit} duplicates • ${current.antiSpam.mentionLimit} mentions`
              )
              .setFooter({ text: 'Safety default: anti-nuke starts in log-only mode until you change its action.' }),
          ],
        });
      }

      if (!group && sub === 'log-channel') {
        const channel = interaction.options.getChannel('channel', true);
        current = await saveSecurityConfig(client, interaction.guildId, { logChannelId: channel.id });
        return InteractionHelper.safeEditReply(interaction, { content: `✅ Security alerts will be sent to ${channel}.` });
      }

      if (!group && sub === 'panic') {
        const enabled = interaction.options.getBoolean('enabled', true);
        current = await saveSecurityConfig(client, interaction.guildId, { panic: enabled });
        return InteractionHelper.safeEditReply(interaction, {
          content: enabled
            ? '🚨 Panic mode enabled. New joins will be blocked until you disable it.'
            : '✅ Panic mode disabled.',
        });
      }

      if (group === 'antinuke') {
        if (sub === 'enabled') {
          const enabled = interaction.options.getBoolean('value', true);
          await saveSecurityConfig(client, interaction.guildId, { antiNuke: { enabled } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Anti-nuke ${enabled ? 'enabled' : 'disabled'}.` });
        }
        if (sub === 'action') {
          const action = interaction.options.getString('action', true);
          await saveSecurityConfig(client, interaction.guildId, { antiNuke: { action } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Anti-nuke response set to **${action}**.` });
        }
        if (sub === 'limits') {
          const minuteLimit = interaction.options.getInteger('per_minute', true);
          const hourLimit = interaction.options.getInteger('per_hour', true);
          await saveSecurityConfig(client, interaction.guildId, { antiNuke: { minuteLimit, hourLimit } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Anti-nuke limits: **${minuteLimit}/min • ${hourLimit}/hour**.` });
        }
      }

      if (group === 'joingate') {
        if (sub === 'enabled') {
          const enabled = interaction.options.getBoolean('value', true);
          await saveSecurityConfig(client, interaction.guildId, { joinGate: { enabled } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Join Gate ${enabled ? 'enabled' : 'disabled'}.` });
        }
        if (sub === 'action') {
          const action = interaction.options.getString('action', true);
          await saveSecurityConfig(client, interaction.guildId, { joinGate: { action } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Join Gate response set to **${action}**.` });
        }
        if (sub === 'account-age') {
          const minimumAccountAgeDays = interaction.options.getInteger('days', true);
          await saveSecurityConfig(client, interaction.guildId, { joinGate: { minimumAccountAgeDays } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Minimum account age set to **${minimumAccountAgeDays} days**.` });
        }
        if (sub === 'filters') {
          const patch = {};
          for (const [optionName, configName] of [
            ['no_avatar', 'noAvatar'],
            ['unauthorized_bots', 'unauthorizedBots'],
            ['unverified_bots', 'unverifiedBots'],
            ['advertising_names', 'advertisingNames'],
          ]) {
            const value = interaction.options.getBoolean(optionName);
            if (value !== null) patch[configName] = value;
          }
          await saveSecurityConfig(client, interaction.guildId, { joinGate: patch });
          return InteractionHelper.safeEditReply(interaction, { content: '✅ Join Gate filters updated.' });
        }
        if (sub === 'name-pattern') {
          const pattern = interaction.options.getString('pattern', true);
          const patterns = [...new Set([...(current.joinGate.blockedNamePatterns || []), pattern])].slice(0, 50);
          await saveSecurityConfig(client, interaction.guildId, { joinGate: { blockedNamePatterns: patterns } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Blocked name pattern added: \`${pattern}\`.` });
        }
        if (sub === 'clear-patterns') {
          await saveSecurityConfig(client, interaction.guildId, { joinGate: { blockedNamePatterns: [] } });
          return InteractionHelper.safeEditReply(interaction, { content: '✅ Custom blocked-name patterns cleared.' });
        }
      }

      if (group === 'antispam') {
        if (sub === 'enabled') {
          const enabled = interaction.options.getBoolean('value', true);
          await saveSecurityConfig(client, interaction.guildId, { antiSpam: { enabled } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Anti-spam ${enabled ? 'enabled' : 'disabled'}.` });
        }
        if (sub === 'action') {
          const action = interaction.options.getString('action', true);
          await saveSecurityConfig(client, interaction.guildId, { antiSpam: { action } });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ Anti-spam response set to **${action}**.` });
        }
        if (sub === 'limits') {
          const patch = {};
          const mappings = [
            ['window_seconds', 'windowSeconds'],
            ['messages', 'messageLimit'],
            ['duplicates', 'duplicateLimit'],
            ['mentions', 'mentionLimit'],
            ['caps_percent', 'capsPercent'],
            ['timeout_minutes', 'timeoutMinutes'],
          ];
          for (const [optionName, configName] of mappings) {
            const value = interaction.options.getInteger(optionName);
            if (value !== null) patch[configName] = value;
          }
          await saveSecurityConfig(client, interaction.guildId, { antiSpam: patch });
          return InteractionHelper.safeEditReply(interaction, { content: '✅ Anti-spam limits updated.' });
        }
      }

      if (group === 'trust') {
        if (sub === 'list') {
          const users = (current.trustedUsers || []).map((id) => `<@${id}>`).join(', ') || 'None';
          const roles = (current.trustedRoles || []).map((id) => `<@&${id}>`).join(', ') || 'None';
          return InteractionHelper.safeEditReply(interaction, {
            embeds: [new EmbedBuilder().setTitle('🛡️ Trusted Security Entities').addFields(
              { name: 'Users', value: users.slice(0, 1000) },
              { name: 'Roles', value: roles.slice(0, 1000) },
            )],
          });
        }

        if (sub.startsWith('user-')) {
          const user = interaction.options.getUser('user', true);
          const set = new Set(current.trustedUsers || []);
          if (sub === 'user-add') set.add(user.id); else set.delete(user.id);
          await saveSecurityConfig(client, interaction.guildId, { trustedUsers: [...set] });
          return InteractionHelper.safeEditReply(interaction, { content: `✅ ${user} ${sub === 'user-add' ? 'trusted' : 'removed from trusted users'}.` });
        }

        const role = interaction.options.getRole('role', true);
        const set = new Set(current.trustedRoles || []);
        if (sub === 'role-add') set.add(role.id); else set.delete(role.id);
        await saveSecurityConfig(client, interaction.guildId, { trustedRoles: [...set] });
        return InteractionHelper.safeEditReply(interaction, { content: `✅ ${role} ${sub === 'role-add' ? 'trusted' : 'removed from trusted roles'}.` });
      }

      if (group === 'quarantine') {
        if (sub === 'list') {
          const records = await getQuarantineRecords(client, interaction.guildId);
          const entries = Object.values(records);
          if (!entries.length) return InteractionHelper.safeEditReply(interaction, { content: 'Nobody is currently in Cloudy security quarantine.' });
          return InteractionHelper.safeEditReply(interaction, {
            embeds: [
              new EmbedBuilder()
                .setTitle('🚨 Security Quarantine')
                .setDescription(entries.map((entry) =>
                  `• <@${entry.userId}> — ${entry.reason || 'No reason'} • ${entry.removedRoleIds?.length || 0} role(s) held`
                ).join('\n').slice(0, 4000)),
            ],
          });
        }
        const user = interaction.options.getUser('user', true);
        const released = await releaseQuarantine(client, interaction.guild, user.id);
        return InteractionHelper.safeEditReply(interaction, { content: released ? `✅ ${user} released from quarantine.` : `${user} is not quarantined.` });
      }

      if (group === 'backup') {
        if (sub === 'create') {
          const backup = await createSecurityBackup(client, interaction.guild);
          return InteractionHelper.safeEditReply(interaction, {
            content: `✅ Security backup \`${backup.id}\` saved: **${backup.roles.length} roles** and **${backup.channels.length} channels**.`,
          });
        }
        if (sub === 'list') {
          const backups = await getSecurityBackups(client, interaction.guildId);
          if (!backups.length) return InteractionHelper.safeEditReply(interaction, { content: 'No security backups saved.' });
          return InteractionHelper.safeEditReply(interaction, {
            embeds: [
              new EmbedBuilder()
                .setTitle('💾 Security Backups')
                .setDescription(backups.map((backup) =>
                  `• \`${backup.id}\` — <t:${Math.floor(new Date(backup.createdAt).getTime() / 1000)}:F> • ${backup.roles.length} roles • ${backup.channels.length} channels`
                ).join('\n')),
            ],
          });
        }
        const id = interaction.options.getString('id', true);
        const restored = await restoreSecurityBackup(client, interaction.guild, id);
        return InteractionHelper.safeEditReply(interaction, {
          content: `✅ Restore complete. Recreated **${restored.createdRoles.length} role(s)** and **${restored.createdChannels.length} channel(s)**. Existing objects were not overwritten or deleted.`,
        });
      }

      return InteractionHelper.safeEditReply(interaction, { content: 'No matching security action was found.' });
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `❌ ${error?.message || 'Security configuration failed.'}`,
        embeds: [],
      });
    }
  },
};
