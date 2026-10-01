
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:30000 });

const guildId='1532882647838228723';
const oldRules='1533189582064062564';

const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const registry = await client.query(
    `
    SELECT t.key,
           elem
      FROM temp_data t
      CROSS JOIN LATERAL jsonb_array_elements(t.value) AS elem
     WHERE t.key LIKE $1
       AND jsonb_typeof(t.value)='array'
       AND (
         elem->>'channelId' = $2
         OR elem->>'backingChannelId' = $2
         OR lower(COALESCE(elem->>'name','')) IN ('rules','discord rules')
         OR lower(COALESCE(elem->>'title','')) IN ('rules','discord rules')
       )
     ORDER BY t.key
    `,
    [`cloudy:recovery-backup:%:cloudy:embed-registry:${guildId}%`, oldRules]
  );

  const templateExact = await client.query(
    `
    SELECT key,value,created_at
      FROM temp_data
     WHERE key LIKE $1
        OR key LIKE $2
     ORDER BY key
    `,
    [
      `cloudy:recovery-backup:%:cloudy:embed-template:${guildId}:${oldRules}%`,
      `cloudy:recovery-backup:%:cloudy:embed-template:${guildId}:%rules%`
    ]
  );

  const backupRowsContainingOldChannel = await client.query(
    `
    SELECT key,value,created_at
      FROM temp_data
     WHERE key LIKE 'cloudy:recovery-backup:%'
       AND value::text LIKE $1
     ORDER BY key
     LIMIT 100
    `,
    [`%${oldRules}%`]
  );

  console.error('RULES_RECOVERY_REGISTRY ' + JSON.stringify(registry.rows));
  console.error('RULES_RECOVERY_TEMPLATE_EXACT ' + JSON.stringify(templateExact.rows));
  console.error('RULES_RECOVERY_OLD_CHANNEL_ROWS ' + JSON.stringify(backupRowsContainingOldChannel.rows));

  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
