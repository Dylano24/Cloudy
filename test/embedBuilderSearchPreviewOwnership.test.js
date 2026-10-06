import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as builderCleanup from '../src/utils/builderSessionCleanup.js';
import { scheduleTransientMessageDeletion } from '../src/utils/transientResponse.js';

test('split Search preview is explicitly owned by the Builder lifecycle', () => {
  assert.equal(typeof builderCleanup.registerBuilderPreviewMessage, 'function');

  const preview = {
    id: 'search-preview-message',
    embeds: [{ title: 'Messages Purged', description: 'Deleted {dynamic} messages.' }],
    channel: { name: 'general' },
    deletable: true,
    delete: async () => {},
  };

  builderCleanup.registerBuilderPreviewMessage(preview);
  assert.equal(builderCleanup.isBuilderSessionMessage(preview), true);
  assert.equal(scheduleTransientMessageDeletion(preview), false);
  builderCleanup.unregisterBuilderPreviewMessage?.(preview);
});

test('final Builder startup guard guarantees refreshBuilderPreviewOnly when editor callbacks reference it', () => {
  const source = fs.readFileSync('scripts/patch-builder-final-controls.js', 'utf8');

  assert.match(source, /refreshBuilderPreviewOnly/);
  assert.match(source, /BUILDER_PREVIEW_HELPER_FINAL_GUARD/);
});
