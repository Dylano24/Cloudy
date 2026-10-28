import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CloudyError, TitanBotError, ErrorTypes, categorizeError, createError } from '../src/utils/errorHandler.js';
import { shopConfig } from '../src/config/shop/index.js';

test('Cloudy error is canonical while legacy error imports remain compatible', () => {
  assert.equal(TitanBotError, CloudyError);
  const error = createError('Example problem', ErrorTypes.VALIDATION, 'Example');
  assert.equal(error.name, 'CloudyError');
  assert.ok(error instanceof CloudyError);
  assert.ok(error instanceof TitanBotError);
  assert.equal(categorizeError(error), ErrorTypes.VALIDATION);
});

test('Cloudy replaces user-facing startup, shop, help and default footer branding', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const help = readFileSync(new URL('../src/handlers/help/helpButtons.js', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../src/config/bot.js', import.meta.url), 'utf8');
  assert.match(app, /class CloudyBot extends Client/);
  assert.match(app, /Starting Cloudy/);
  assert.doesNotMatch(app, /TitanBot/);
  assert.equal(shopConfig.name, 'Cloudy Shop');
  assert.match(help, /github\.com\/Dylano24\/Cloudy\/issues/);
  assert.doesNotMatch(help, /codebymitch\/TitanBot|TitanBot Bug Reporting/i);
  assert.match(config, /footer:[\s\S]*?text: "Cloudy"/);
  assert.doesNotMatch(config, /Titan Bot/);
});

test('account database defaults remain compatible with existing installations', () => {
  const postgresConfig = readFileSync(new URL('../src/config/database/postgres.js', import.meta.url), 'utf8');
  // Avoid automatic migration or renaming of preexisting PostgreSQL databases.
  assert.match(postgresConfig, /DEFAULT_POSTGRES_URL = 'postgresql:\/\/localhost:5432\/titanbot'/);
  assert.match(postgresConfig, /application_name: 'cloudy-bot'/);
});
