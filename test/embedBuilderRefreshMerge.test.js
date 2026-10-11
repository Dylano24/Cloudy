import test from 'node:test';
import assert from 'node:assert/strict';
import { queueBuilderRefresh } from '../src/commands/Tools/embedbuilder.js';

test('preview only update preserves a dashboard update waiting behind an active edit', async () => {
  let release;
  let previews = 0;
  const controls = [];
  const state = { title: 'Preview', message: 'Original', sideColor: 0xffffff, showLogo: false, bottomLine: null, componentRows: [],
    builderBotManaged: true, builderPreviewUnavailable: false,
    builderDashboardMessageId: 'dashboard', builderDashboardMessage: { edit: async payload => { controls.push(payload); } },
  };
  const interaction = { editReply: async () => { if (++previews === 1) await new Promise(resolve => { release = resolve; }); } };
  const running = queueBuilderRefresh(interaction, state, true, true);
  state.showLogo = true;
  await queueBuilderRefresh(interaction, state, true, true);
  state.message = 'Latest body';
  await queueBuilderRefresh(interaction, state, false, true);
  release();
  await running;
  assert.equal(controls.length, 2);
  assert.equal(controls.at(-1).components[1].toJSON().components[0].disabled, true);
  assert.equal(previews, 2);
});
