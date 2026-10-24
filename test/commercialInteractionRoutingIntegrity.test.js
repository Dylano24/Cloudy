import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('general interaction router reserves FAQ and Fix Guide component ids for their dedicated event handlers', () => {
  const source = fs.readFileSync('src/events/interactionCreate.js', 'utf8');

  assert.match(source, /FAQ_AI_BUTTON_ID/);
  assert.match(source, /FAQ_AI_MODAL_ID/);
  assert.match(source, /FIX_GUIDE_ASK_BUTTON_ID/);
  assert.match(source, /FIX_GUIDE_ASK_MODAL_ID/);
  assert.match(source, /isDedicatedAssistantInteraction/);

  const guardIndex = source.indexOf('isDedicatedAssistantInteraction');
  const genericButtonIndex = source.indexOf('interaction.isButton()', guardIndex);
  assert.ok(guardIndex >= 0);
  assert.ok(genericButtonIndex > guardIndex, 'dedicated assistant guard must run before generic button dispatch');
});

test('Fix Guide ready reconciliation re-registers the live panel in the Embed Builder registry', () => {
  const source = fs.readFileSync('src/events/cloudyOwnerAssistantReady.js', 'utf8');

  assert.match(source, /registerCloudyEmbedMessage/);
  assert.match(source, /await registerCloudyEmbedMessage\(panelMessage, 'bot-history'\)/);
});

test('Fix Guide ready reconciliation validates that only its Ask action remains on the panel', () => {
  const source = fs.readFileSync('src/events/cloudyOwnerAssistantReady.js', 'utf8');

  assert.match(source, /isFixGuidePanelComponentContractSafe/);
  assert.match(source, /FIX_GUIDE_ASK_BUTTON_ID/);
  assert.match(source, /message\.edit\(\{ components:/);
});


function walkJs(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walkJs(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('reserved assistant custom IDs have one literal owner and cannot collide with ticket routing', () => {
  const files = walkJs('src');
  const reserved = new Map([
    ['faq_ai_question', 'src/services/faqAiService.js'],
    ['faq_ai_question_modal', 'src/services/faqAiService.js'],
    ['cloudy_fix_guide_ask', 'src/events/cloudyOwnerAssistantReady.js'],
    ['cloudy_fix_guide_ask_modal', 'src/events/cloudyOwnerAssistantReady.js'],
  ]);

  for (const [customId, owner] of reserved) {
    const literalOwners = files
      .filter(file => fs.readFileSync(file, 'utf8').includes(`'${customId}'`)
        || fs.readFileSync(file, 'utf8').includes(`"${customId}"`))
      .map(file => file.replaceAll('\\\\', '/'));

    assert.deepEqual(
      literalOwners,
      [owner],
      `reserved custom ID ${customId} must have exactly one literal source owner`,
    );
  }

  for (const file of [
    'src/services/faqAiService.js',
    'src/events/faqAiInteraction.js',
    'src/events/cloudyOwnerAssistantReady.js',
    'src/events/cloudyFixGuideInteraction.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /['"]create_ticket['"]/, `${file} must never own the ticket-create action`);
  }
});
