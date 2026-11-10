import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportSubmittedEmbed } from '../src/utils/reportSubmittedEmbed.js';
import { isPrivateReportCasePayload, isReportUpdateTitle } from '../src/utils/reportCasePrivacy.js';
import reportMessage from '../src/commands/Utility/reportMessage.js';

test('Cloudy report modal shows SMALL guidance between Discord notice and required Reason input', async () => {
  let modal;
  const interaction = {
    id: 'modal-id', user: { id: 'reporter' }, targetMessage: { id: 'message', author: { id: 'target' } },
    showModal: async builder => { modal = builder.toJSON(); },
    awaitModalSubmit: async () => null,
  };
  await reportMessage.execute(interaction, {}, {});
  assert.equal(modal.title, 'Cloudy report');
  assert.equal(modal.components.length, 2, 'no bulky Important note text block in the modal');
  assert.equal(modal.components[0].content, "-# Please briefly explain why you're reporting this message and provide any relevant context.");
  assert.equal(modal.components[1].label, 'Reason');
  assert.equal(modal.components[1].component.style, 2, 'Reason remains a multi-line field');
  assert.equal(modal.components[1].component.required, true);
  assert.equal(modal.components[1].component.custom_id, 'reason');
});

test('both report submission routes share exact private confirmation with real values', () => {
  const embed = buildReportSubmittedEmbed({
    reportNumber: 89, reportedMemberId: '123456789012345678', reportedMessageText: 'Original reported message goes here.',
    reason: 'This message is offensive!!',
  }).toJSON();
  assert.equal(embed.title, 'Report submitted');
  assert.equal(embed.description, 'Your report n•89 has been successfully submitted to our moderation team.\n\nThank you for bringing this to our attention. Our team will review the reported message and take appropriate action if necessary.');
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ['Reported member', '<@123456789012345678>'],
    ['Reported message', 'Original reported message goes here.'],
    ['Report reason', 'This message is offensive!!'],
  ]);
  assert.deepEqual(embed.footer, { text: 'Cloudy Inc. Moderation team' });
  assert.equal(embed.color, 0xFFFFFF);
});

test('renamed audience-specific staff log titles remain within private report handling', () => {
  for (const title of ['Report n•89 update', 'Moderation n•89 update', 'Report n•89 closed', 'Moderation n•89 automatically deleted']) {
    assert.equal(isReportUpdateTitle(title), true);
    assert.equal(isPrivateReportCasePayload({ embeds: [{ title }] }), true);
  }
});

test('confirmation keeps original reported emoji and reason verbatim', () => {
  const embed = buildReportSubmittedEmbed({
    reportNumber: 90, reportedMemberId: '123456789012345678',
    reportedMessageText: 'Original 📦 emoji and **markdown**',
    reason: 'Offensive 😠 content!',
  }).toJSON();
  assert.equal(embed.fields[1].value, 'Original 📦 emoji and **markdown**');
  assert.equal(embed.fields[2].value, 'Offensive 😠 content!');
});
