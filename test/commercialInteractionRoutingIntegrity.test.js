import assert from 'node:assert/strict';
import fs from 'node:fs';
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
