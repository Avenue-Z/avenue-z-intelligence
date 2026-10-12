import {createClient} from '@libsql/client';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
if(!process.env.TURSO_DATABASE_URL)throw new Error('Configure the application database before applying migrations');
const client=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
try{
 await client.execute('CREATE TABLE IF NOT EXISTS _avenue_migrations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, appliedAt TEXT NOT NULL)');
 for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  const sql=await readFile(new URL(`../drizzle/${file}`,import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
  const old=(await client.execute({sql:'SELECT hash FROM _avenue_migrations WHERE id=?',args:[file]})).rows[0];
  if(old){if(old.hash!==hash)throw new Error('Applied migration was changed');continue;}
  const statements=sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
  await client.batch([...statements,{sql:'INSERT INTO _avenue_migrations(id,hash,appliedAt) VALUES(?,?,?)',args:[file,hash,new Date().toISOString()]}],'write');
  console.log(`Applied ${file}`);
 }
}catch{console.error('Database migration failed. Review the database configuration and migration state.');process.exitCode=1;}
finally{client.close();}
