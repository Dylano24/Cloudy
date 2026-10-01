
import pg from 'pg';
const {Pool}=pg;
const url=String(process.env.POSTGRES_URL||process.env.DATABASE_URL||'').trim();
if(!url) throw new Error('NO_POSTGRES_URL');
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:30000});
const client=await pool.connect();
try{
 await client.query('BEGIN TRANSACTION READ ONLY');
 const q=await client.query(
   `SELECT key, created_at
      FROM temp_data
     WHERE key LIKE 'cloudy:recovery-backup:%'
     ORDER BY created_at ASC,key ASC`
 );
 const prefixes=new Map();
 for(const row of q.rows){
   const m=String(row.key).match(/^(cloudy:recovery-backup:[^:]+(?::[^:]+)*?):cloudy:/);
   const prefix=m?.[1]||String(row.key).split(':cloudy:')[0];
   if(!prefixes.has(prefix)) prefixes.set(prefix,{prefix,count:0,first:row.created_at,last:row.created_at,samples:[]});
   const x=prefixes.get(prefix); x.count++; x.last=row.created_at; if(x.samples.length<6)x.samples.push(row.key);
 }
 console.error('RECOVERY_BACKUP_PREFIXES '+JSON.stringify([...prefixes.values()]));
 await client.query('ROLLBACK');
}finally{client.release();await pool.end();}
