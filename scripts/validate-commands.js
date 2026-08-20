import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGroupedTopLevelCommand } from '../src/config/commands/groupedCommands.js';

const ROOT = process.cwd();
const COMMANDS_DIR = path.join(ROOT, 'src', 'commands');
const EVENTS_DIR = path.join(ROOT, 'src', 'events');
const MAX_TOP_LEVEL_COMMANDS = 100;
const MAX_OPTIONS = 25;
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
  console.error(`❌ ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.warn(`⚠️  ${message}`);
}

async function walk(directory, { skipModules = false } = {}) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (skipModules && entry.isDirectory() && entry.name === 'modules') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walk(fullPath, { skipModules }));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function validateOptions(options, owner) {
  if (!Array.isArray(options)) return;
  if (options.length > MAX_OPTIONS) {
    fail(`${owner} has ${options.length} options; Discord allows at most ${MAX_OPTIONS}.`);
  }

  const names = new Set();
  for (const option of options) {
    if (!option?.name) continue;
    if (names.has(option.name)) {
      fail(`${owner} contains duplicate option/subcommand name "${option.name}".`);
    }
    names.add(option.name);

    if (Array.isArray(option.options)) {
      validateOptions(option.options, `${owner} ${option.name}`);
    }
  }
}

async function validateCommands() {
  const files = await walk(COMMANDS_DIR, { skipModules: true });
  const names = new Map();
  let validCommands = 0;
  let groupedCommands = 0;

  console.log(`\nChecking ${files.length} command file(s)...`);

  for (const file of files) {
    const display = relative(file);
    try {
      const imported = await import(`${pathToFileURL(file).href}?validate=${Date.now()}-${Math.random()}`);
      const command = imported.default || imported;

      if (!command?.data || typeof command.execute !== 'function') {
        fail(`${display} does not export both command data and execute().`);
        continue;
      }

      if (typeof command.data.toJSON !== 'function') {
        fail(`${display} command data does not provide toJSON().`);
        continue;
      }

      let json;
      try {
        json = command.data.toJSON();
      } catch (error) {
        fail(`${display} has an invalid Discord command builder: ${error?.message || error}`);
        continue;
      }

      const name = String(json?.name || '').trim();
      if (!name) {
        fail(`${display} has no command name.`);
        continue;
      }

      if (typeof json.description === 'string' && json.description.length > 100) {
        fail(`/${name} description is ${json.description.length} characters; Discord allows 100.`);
      }
      validateOptions(json.options, `/${name}`);
      validCommands += 1;

      if (isGroupedTopLevelCommand(name)) {
        groupedCommands += 1;
        console.log(`✅ /${name} — ${display} (implementation module; grouped in another command)`);
        continue;
      }

      if (names.has(name)) {
        fail(`Duplicate top-level slash command /${name}: ${names.get(name)} and ${display}.`);
      } else {
        names.set(name, display);
      }

      console.log(`✅ /${name} — ${display}`);
    } catch (error) {
      fail(`${display} could not be imported: ${error?.stack || error?.message || error}`);
    }
  }

  if (names.size > MAX_TOP_LEVEL_COMMANDS) {
    fail(`There are ${names.size} registered top-level slash commands; Discord allows ${MAX_TOP_LEVEL_COMMANDS} per scope.`);
  }

  console.log(
    `\nCommand result: ${validCommands}/${files.length} files importable, ` +
    `${names.size} registered top-level command(s), ${groupedCommands} grouped implementation module(s).`
  );
  return { files: files.length, validCommands, uniqueCommands: names.size, groupedCommands };
}

async function validateEvents() {
  const files = await walk(EVENTS_DIR);
  const eventRegistrations = new Map();
  let validEvents = 0;

  console.log(`\nChecking ${files.length} event file(s)...`);

  for (const file of files) {
    const display = relative(file);
    try {
      const imported = await import(`${pathToFileURL(file).href}?validate=${Date.now()}-${Math.random()}`);
      const event = imported.default || imported;

      if (!event?.name || typeof event.execute !== 'function') {
        fail(`${display} does not export both event name and execute().`);
        continue;
      }

      const key = `${String(event.name)}:${event.once === true ? 'once' : 'on'}`;
      const list = eventRegistrations.get(key) || [];
      list.push(display);
      eventRegistrations.set(key, list);
      validEvents += 1;
      console.log(`✅ ${String(event.name)} — ${display}`);
    } catch (error) {
      fail(`${display} could not be imported: ${error?.stack || error?.message || error}`);
    }
  }

  for (const [eventName, listeners] of eventRegistrations) {
    if (listeners.length > 1) {
      warn(`${eventName} has ${listeners.length} listeners: ${listeners.join(', ')}`);
    }
  }

  console.log(`\nEvent result: ${validEvents}/${files.length} event file(s) importable.`);
  return { files: files.length, validEvents };
}

async function main() {
  process.env.NODE_ENV ||= 'test';

  const commandResult = await validateCommands();
  const eventResult = await validateEvents();

  console.log('\n========================================');
  console.log(`Commands: ${commandResult.uniqueCommands} registered top-level`);
  console.log(`Grouped:  ${commandResult.groupedCommands} implementation modules`);
  console.log(`Events:   ${eventResult.validEvents}/${eventResult.files} importable`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Failures: ${failures.length}`);
  console.log('========================================\n');

  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
