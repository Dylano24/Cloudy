import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as buttonEditor from '../src/services/embedBuilderButtonEditorService.js';

function row(...components) {
  return { type: 1, components };
}

function button(label, customId, extra = {}) {
  return {
    type: 2,
    style: 2,
    label,
    custom_id: customId,
    ...extra,
  };
}

test('custom emoji changes only the selected button and preserves its action', () => {
  assert.equal(typeof buttonEditor.setBuilderButtonEmoji, 'function');

  const source = [
    row(
      button('First', 'first_action'),
      button('Second', 'second_action', { disabled: true }),
    ),
  ];

  const next = buttonEditor.setBuilderButtonEmoji(source, '0:1', {
    id: '123456789012345678',
    name: 'cloudy',
    animated: true,
  });

  assert.deepEqual(next[0].components[0], source[0].components[0]);
  assert.equal(next[0].components[1].label, 'Second');
  assert.equal(next[0].components[1].custom_id, 'second_action');
  assert.equal(next[0].components[1].disabled, true);
  assert.deepEqual(next[0].components[1].emoji, {
    id: '123456789012345678',
    name: 'cloudy',
    animated: true,
  });
});

test('button emoji can be removed without changing label/style/action', () => {
  assert.equal(typeof buttonEditor.setBuilderButtonEmoji, 'function');

  const source = [
    row(button('Link', null, {
      style: 5,
      url: 'https://example.com',
      emoji: { id: '123456789012345678', name: 'cloudy', animated: false },
    })),
  ];

  const next = buttonEditor.setBuilderButtonEmoji(source, '0:0', null);
  assert.equal(next[0].components[0].label, 'Link');
  assert.equal(next[0].components[0].style, 5);
  assert.equal(next[0].components[0].url, 'https://example.com');
  assert.equal('emoji' in next[0].components[0], false);
});

test('button manager exposes a custom emoji target selector below button controls', () => {
  assert.equal(typeof buttonEditor.buildBuilderButtonManagerPayload, 'function');

  const payload = buttonEditor.buildBuilderButtonManagerPayload({
    componentRows: [row(button('Ask a question', 'cloudy_builder_action:abc'))],
  });
  const data = payload.components.map(component => component.toJSON?.() || component);
  const ids = data.flatMap(item => item.components || []).map(item => item.custom_id);

  assert.ok(ids.includes('embed_button_emoji_target'));
});

test('emoji browser pages through every custom emoji instead of truncating at 125', () => {
  assert.equal(typeof buttonEditor.buildButtonEmojiPagePayload, 'function');

  const emojis = new Map();
  for (let index = 0; index < 181; index += 1) {
    const id = String(100000000000000000n + BigInt(index));
    emojis.set(id, {
      id,
      name: `emoji_${String(index).padStart(3, '0')}`,
      animated: index % 2 === 0,
      toString: () => `<:emoji_${index}:${id}>`,
    });
  }

  const guild = { id: '999999999999999999', name: 'Cloudy emojis' };
  const first = buttonEditor.buildButtonEmojiPagePayload(guild, emojis, '0:0', 0);
  const last = buttonEditor.buildButtonEmojiPagePayload(guild, emojis, '0:0', 2);

  const firstRows = first.components.map(component => component.toJSON?.() || component);
  const firstOptions = firstRows
    .flatMap(rowData => rowData.components || [])
    .flatMap(component => component.options || []);
  const lastRows = last.components.map(component => component.toJSON?.() || component);
  const lastOptions = lastRows
    .flatMap(rowData => rowData.components || [])
    .flatMap(component => component.options || []);

  assert.equal(firstOptions.length, 75);
  assert.equal(lastOptions.length, 31);
  assert.ok(firstRows.flatMap(rowData => rowData.components || []).some(component =>
    String(component.custom_id || '').startsWith('embed_button_emoji_next:')
  ));
  assert.ok(lastRows.flatMap(rowData => rowData.components || []).some(component =>
    String(component.custom_id || '').startsWith('embed_button_emoji_prev:')
  ));
});

test('Railway final startup guard preserves button custom emoji support', () => {
  const source = fs.readFileSync('scripts/patch-builder-final-controls.js', 'utf8');
  assert.match(source, /BUILDER_BUTTON_CUSTOM_EMOJI_V1/);
  assert.match(source, /embed_button_emoji_target/);
  assert.match(source, /openButtonEmojiBrowser/);
});
