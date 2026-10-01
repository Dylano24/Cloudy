
import pg from 'pg';
const {Pool}=pg;
const url=String(process.env.POSTGRES_URL||process.env.DATABASE_URL||'').trim();
if(!url) throw new Error('NO_POSTGRES_URL');
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:60000});
const needles=[
  '1543364112019488909',
  '1543287452410716160',
  'Y93discordnitrowhite',
  'Discord rules'
];
const qi=s=>'"'+String(s).replaceAll('"','""')+'"';
const client=await pool.connect();
try{
  await client.query('BEGIN TRANSACTION READ ONLY');
  const cols=await client.query(`
    SELECT table_schema,table_name,column_name,data_type,udt_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND (
         data_type IN ('text','character varying','json','jsonb')
         OR udt_name IN ('text','varchar','json','jsonb')
       )
     ORDER BY table_name,ordinal_position`);
  const hits=[];
  for(const col of cols.rows){
    const table=qi(col.table_name), column=qi(col.column_name);
    for(const needle of needles){
      try{
        const q=await client.query(
          `SELECT row_to_json(t) AS row
             FROM ${table} t
            WHERE ${column}::text ILIKE $1
            LIMIT 5`,
          ['%'+needle+'%']
        );
        if(q.rows.length){
          hits.push({table:col.table_name,column:col.column_name,needle,rows:q.rows.map(x=>x.row)});
        }
      }catch(e){
        hits.push({table:col.table_name,column:col.column_name,needle,error:String(e.message||e)});
      }
    }
  }
  console.error('RULES_ALL_TABLE_HITS '+JSON.stringify(hits));
  console.error('RULES_SEARCHED_COLUMNS '+JSON.stringify(cols.rows));
  await client.query('ROLLBACK');
}finally{client.release();await pool.end();}
