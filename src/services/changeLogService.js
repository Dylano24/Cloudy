// #change-logs (owner's choice): staff note the settings they change on a
// game server with /changelog; Cloudy posts one styled embed per change log.
import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from './cloudyChannelResolver.js';

const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const CHANGE_LOG_MODAL_ID = 'changelog_form';

export function changeLogModal() {
  const input = (id, label, style, { placeholder, required = true, max }) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
      .setPlaceholder(placeholder).setRequired(required).setMaxLength(max));
  return new ModalBuilder()
    .setCustomId(CHANGE_LOG_MODAL_ID)
    .setTitle('Change log')
    .addComponents(
      input('server', 'Server', TextInputStyle.Short, { placeholder: 'Cloudy Rust', max: 60 }),
      input('changes', 'Changes (one per line)', TextInputStyle.Paragraph, { placeholder: 'Gather rate set to 2x', max: 3000 }),
      input('note', 'Note', TextInputStyle.Paragraph, { placeholder: 'Optional', required: false, max: 500 }),
    );
}

const clean = (value, max) => String(value || '').replace(/@(everyone|here)/gi, '@​$1').trim().slice(0, max);

export function buildChangeLog({ server, changes, note, userId, time = Date.now() }) {
  const lines = String(changes || '').split(/\r?\n/).map(line => line.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  return {
    embeds: [{
      title: 'Server changes',
      description: [
        `**Server:** ${clean(server, 60)}`,
        '',
        ...lines.map(line => `• ${clean(line, 300)}`),
        ...(note ? ['', clean(note, 500)] : []),
        '',
        `**Changed by:** <@${userId}>`,
        `**Time:** <t:${Math.floor(time / 1000)}:f>`,
      ].join('\n').slice(0, 4096),
      color: 0xFFFFFF,
      thumbnail: { url: LOGO },
      footer: { text: FOOTER },
    }],
    allowedMentions: { parse: [] },
  };
}

export function changeLogChannel(guild) {
  return findCloudyChannelByAlias(guild, getCloudyChannelDefinition('changeLogs')?.aliases || [], { textOnly: true });
}
