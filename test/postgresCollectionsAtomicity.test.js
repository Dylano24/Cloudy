import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';

function collectionDatabase(table, failAtInsert = Infinity) {
  let rows = ['existing'];
  let transaction = null;
  let inserts = 0;
  let releases = 0;
  const query = async (sql, params) => {
    if (sql === 'BEGIN') transaction = [...rows];
    else if (sql === 'COMMIT') { rows = transaction; transaction = null; }
    else if (sql === 'ROLLBACK') transaction = null;
    else if (sql.includes(`DELETE FROM ${table}`)) {
      if (transaction) transaction.length = 0;
      else rows.length = 0;
    } else if (sql.includes(`INSERT INTO ${table}`)) {
      inserts += 1;
      if (inserts === failAtInsert) throw new Error('collection insert failed');
      (transaction || rows).push(params[1]);
    }
    return { rows: [] };
  };
  const database = new PostgreSQLDatabase();
  database.isConnected = true;
  database.pool = {
    query,
    async connect() { return { query, release() { releases += 1; } }; },
  };
  return { database, rows: () => rows, releases: () => releases };
}

for (const [name, table, key, value] of [
  ['birthdays', 'birthdays', 'guild:123456789012345678:birthdays', {
    first: { month: 1, day: 2 }, second: { month: 3, day: 4 },
  }],
  ['giveaways', 'giveaways', 'guild:123456789012345678:giveaways', [
    { messageId: 'first', endsAt: 1000 }, { messageId: 'second', endsAt: 2000 },
  ]],
]) {
  test(`failed ${name} replacement preserves all previous rows`, async () => {
    const fixture = collectionDatabase(table, 2);
    assert.equal(await fixture.database.set(key, value), false);
    assert.deepEqual(fixture.rows(), ['existing']);
    assert.equal(fixture.releases(), 1);
  });

  test(`successful ${name} replacement commits the complete collection`, async () => {
    const fixture = collectionDatabase(table);
    assert.equal(await fixture.database.set(key, value), true);
    assert.deepEqual(fixture.rows(), ['first', 'second']);
    assert.equal(fixture.releases(), 1);
  });
}
