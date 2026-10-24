import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC_ROOT = 'src';
const RESERVED = new Map([
  ['faq_ai_question', 'faq'],
  ['faq_ai_question_modal', 'faq'],
  ['cloudy_fix_guide_ask', 'fix-guide'],
  ['cloudy_fix_guide_ask_modal', 'fix-guide'],
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && full.endsWith('.js')) files.push(full.replaceAll('\\', '/'));
  }
  return files;
}

function allowedOwner(file, owner) {
  if (owner === 'faq') {
    return file === 'src/services/faqAiService.js'
      || file === 'src/events/faqAiInteraction.js'
      || file === 'src/events/interactionCreate.js';
  }
  if (owner === 'fix-guide') {
    return file === 'src/events/cloudyOwnerAssistantReady.js'
      || file === 'src/events/cloudyFixGuideInteraction.js'
      || file === 'src/events/interactionCreate.js';
  }
  return false;
}

test('reserved assistant interaction ids never leak into unrelated production modules', () => {
  const violations = [];

  for (const file of walk(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');

    for (const [id, owner] of RESERVED) {
      if (!source.includes(id)) continue;
      if (!allowedOwner(file, owner)) {
        violations.push(`${id} appears in unrelated module ${file}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('ticket modules never contain FAQ or Fix Guide reserved ids', () => {
  const violations = [];
  for (const file of walk('src')) {
    if (!/ticket/i.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const id of RESERVED.keys()) {
      if (source.includes(id)) violations.push(`${file}: ${id}`);
    }
  }
  assert.deepEqual(violations, []);
});
