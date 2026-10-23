import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {Store} from '../../lib/server/store';
export function northbeamStore(){
 const db=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+file,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...v:unknown[]){values=v;return statement;},async all(){return {results:db.prepare(sql).all(...values as string[])};},async first(){return db.prepare(sql).get(...values as string[])??null;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as string[]).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async(statements:{run:()=>Promise<unknown>}[])=>Promise.all(statements.map(s=>s.run()))});
 db.exec("INSERT INTO organizations VALUES('avenue-z','Avenue Z',1); INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('autobrush','avenue-z','Autobrush','autobrush','America/New_York','USD','#000','{}')");
 return {db,store};
}
