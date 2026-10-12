import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
it('uses real libSQL transactions for notes, snapshots, and immutable reviews',async()=>{
 const client=createClient({url:'file::memory:'});
 try{
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${f}`,'utf8'));
  const db=sqliteBindings(client),s=new Store(db);
  await s.saveNote('o','a','shared','actor',0);expect((await s.note('o','a')).body).toBe('shared');
  await expect(s.saveNote('o','a','stale','actor',0)).rejects.toThrow('Changed');
  const batch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-11',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{},dataset:'overview'}]} as any;
  await s.persistBatch('o','source',batch,'hash','2026-10-12T13:00:00Z');expect((await s.observations('o','a'))[0].value).toBe(42);expect(await s.observations('o','b')).toEqual([]);
  await s.saveReview('o','a','2026-10-11','first',{revenue:42},'2026-10-12T13:00:00Z');await s.saveReview('o','a','2026-10-11','second',{revenue:43},'2026-10-12T14:00:00Z');expect((await s.reviews('o','a')).filter(r=>r.current)).toHaveLength(1);
  await expect(db.batch([db.prepare("INSERT INTO notes VALUES('o','b','should roll back','a',1,'now')"),db.prepare('INSERT INTO missing_table VALUES(1)')])).rejects.toThrow();
  expect(await s.first("SELECT * FROM notes WHERE clientId='b'")).toBeNull();
 }finally{client.close();}
});
