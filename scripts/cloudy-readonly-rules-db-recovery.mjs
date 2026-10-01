
import pg from 'pg';
const { Pool } = pg;
const url=String(process.env.POSTGRES_URL||process.env.DATABASE_URL||'').trim();
if(!url) throw new Error('NO_POSTGRES_URL');
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:20000});
const client=await pool.connect();
try{
  await client.query('BEGIN TRANSACTION READ ONLY');
  const schema=await client.query(
    `SELECT table_name,
            json_agg(json_build_object('column',column_name,'type',data_type) ORDER BY ordinal_position) AS columns
       FROM information_schema.columns
      WHERE table_schema='public'
      GROUP BY table_name
      ORDER BY table_name`
  );
  const backups=await client.query(
    `SELECT key,created_at FROM temp_data
      WHERE key LIKE 'cloudy:recovery-backup:%'
      ORDER BY created_at ASC`
  );
  console.error('RULES_DB_SCHEMA '+JSON.stringify(schema.rows));
  console.error('RULES_BACKUP_KEYS '+JSON.stringify(backups.rows.map(r=>({key:r.key,created_at:r.created_at}))));
  await client.query('ROLLBACK');
}finally{
  client.release();
  await pool.end();
}
