import test from 'node:test';
import assert from 'node:assert/strict';

// Loading each real command checks ESM evaluation and public slash schemas.
// This test does not execute live Discord actions or require any token.
const commands = [
  [
    "../src/commands/Moderation/dm.js",
    "dm"
  ],
  [
    "../src/commands/Moderation/lock.js",
    "lock"
  ],
  [
    "../src/commands/Moderation/unlock.js",
    "unlock"
  ],
  [
    "../src/commands/Moderation/purge.js",
    "purge"
  ],
  ["../src/commands/Giveaway/giveaway.js", "giveaway"],
  ["../src/commands/Economy/gambling.js", "gamble"],
  ["../src/commands/Economy/games.js", "game"],
  [
    "../src/commands/Economy/inventory.js",
    "inventory"
  ],
  [
    "../src/commands/Utility/todo.js",
    "todo"
  ],
  [
    "../src/commands/Tools/randomuser.js",
    "randomuser"
  ]
];

test('unused import cleanup preserves command loading and registration names', async () => {
  for (const [path, name] of commands) {
    const { default: command } = await import(path);
    assert.equal(command.data.toJSON().name, name, path);
    assert.equal(typeof command.execute, 'function', path);
  }
});
