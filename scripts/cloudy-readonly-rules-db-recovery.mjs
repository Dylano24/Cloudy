
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:30000 });
const old='1533189582064062564';
const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const registries = await client.query(
    `SELECT key, created_at, value
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%:cloudy:embed-registry:%'
      ORDER BY created_at ASC`
  );

  const registryMatches=[];
  for (const row of registries.rows) {
    const arr=Array.isArray(row.value)?row.value:[];
    const matches=arr.filter(e=>String(e?.channelId||e?.backingChannelId||'')===old);
  }

  const direct = await client.query(
    `SELECT key, created_at,
            jsonb_path_query_array(
              value,
              '$[*] ? (@.channelId == $cid || @.backingChannelId == $cid)',
              jsonb_build_object('cid', to_jsonb($1::text))
            ) AS matches
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%:cloudy:embed-registry:%'
      ORDER BY created_at ASC`,
    [old]
  );

  const nonempty=direct.rows.filter(r=>Array.isArray(r.matches) ? r.matches.length : (r.matches && JSON.stringify(r.matches)!=='[]'));
  console.error('RULES_RECOVERY_REGISTRY_MATCHES '+JSON.stringify(nonempty));

  const templateLike = await client.query(
    `SELECT key, created_at, value
       FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%:cloudy:embed-template:%'
        AND (
          value::text ILIKE '%Discord Rules%'
          OR value::text ILIKE '%No Racism or Hate Speech%'
          OR value::text ILIKE '%No Doxxing or Sharing Personal Information%'
          OR value::text ILIKE '%No NSFW or Disturbing Content%'
        )
      ORDER BY created_at ASC`
  );
  console.error('RULES_RECOVERY_TEMPLATE_TEXT_MATCHES '+JSON.stringify(templateLike.rows));

  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
