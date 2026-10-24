import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('general interaction router reserves FAQ and Fix Guide component ids for their dedicated event handlers', () => {
  const source = fs.readFileSync('src/events/interactionCreate.js', 'utf8');

  assert.match(source, /RESERVED_ASSISTANT_CUSTOM_IDS/);
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
    ['faq_ai_question', new Set(['src/config/assistantInteractionIds.js'])],
    ['faq_ai_question_modal', new Set(['src/config/assistantInteractionIds.js'])],
    ['cloudy_fix_guide_ask', new Set(['src/config/assistantInteractionIds.js'])],
    ['cloudy_fix_guide_ask_modal', new Set(['src/config/assistantInteractionIds.js'])],
  ]);

  for (const [customId, allowedReaders] of reserved) {
    const literalReaders = files
      .filter(file => fs.readFileSync(file, 'utf8').includes(`'${customId}'`)
        || fs.readFileSync(file, 'utf8').includes(`"${customId}"`))
      .map(file => file.replaceAll('\\\\', '/'));

    assert.ok(literalReaders.includes([...allowedReaders][0]), `missing canonical owner for ${customId}`);
    assert.deepEqual(
      literalReaders.filter(file => !allowedReaders.has(file)),
      [],
      `reserved custom ID ${customId} is referenced by an unexpected source`,
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


test('FAQ ready reconciliation re-registers the live panel in the Embed Builder registry', () => {
  const source = fs.readFileSync('src/services/faqAiService.js', 'utf8');

  assert.match(source, /registerCloudyEmbedMessage/);
  assert.match(source, /await registerCloudyEmbedMessage\(panelMessage, 'bot-history'\)/);
});
