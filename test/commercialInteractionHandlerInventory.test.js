import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function walk(directory, output = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, output);
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

for (const type of ['buttons', 'selectMenus', 'modals']) {
  test(`commercial interaction audit: ${type} handler names are unique and loadable`, async () => {
    const root = path.resolve('src/interactions', type);
    const files = (await walk(root)).sort((a, b) => a.localeCompare(b));
    assert.ok(files.length > 0, `expected ${type} handlers`);

    const owners = new Map();
    for (const file of files) {
      const module = await import(pathToFileURL(file).href);
      const exports = Array.isArray(module.default) ? module.default : [module.default];

      for (const interaction of exports) {
        assert.ok(interaction?.name, `${file} has no interaction name`);
        assert.equal(typeof interaction.execute, 'function', `${file} has no execute function`);

        const previous = owners.get(interaction.name);
        assert.equal(
          previous,
          undefined,
          `duplicate ${type} handler "${interaction.name}": ${previous} and ${file}`,
        );
        owners.set(interaction.name, file);
      }
    }
  });
}
