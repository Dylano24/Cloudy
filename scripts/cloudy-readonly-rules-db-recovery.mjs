
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:30000 });
const guild='1532882647838228723';
const old='1533189582064062564';
const emoji='1324217883047362590';
const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const keyHits = await client.query(
    `SELECT key, created_at
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%'
        AND (
          key LIKE $1
          OR key ILIKE '%rules%'
        )
      ORDER BY created_at ASC, key ASC
      LIMIT 500`,
    [`%${old}%`]
  );

  const valueHits = await client.query(
    `SELECT key, value, created_at
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%'
        AND (
          value::text LIKE $1
          OR value::text LIKE $2
          OR value::text ILIKE '%"name":"Discord Rules"%'
          OR value::text ILIKE '%"title":"Discord Rules"%'
          OR value::text ILIKE '%No Doxxing or Sharing Personal Information%'
          OR value::text ILIKE '%No NSFW or Disturbing Content%'
        )
      ORDER BY created_at ASC, key ASC
      LIMIT 100`,
    [`%${old}%`, `%${emoji}%`]
  );

  const backupKeys = await client.query(
    `SELECT key, created_at
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%'
      ORDER BY created_at ASC, key ASC
      LIMIT 1000`
  );

  console.error('RULES_RECOVERY_KEY_HITS '+JSON.stringify(keyHits.rows));
  console.error('RULES_RECOVERY_VALUE_HITS '+JSON.stringify(valueHits.rows));
  console.error('RULES_RECOVERY_BACKUP_KEY_INDEX '+JSON.stringify(backupKeys.rows));
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
