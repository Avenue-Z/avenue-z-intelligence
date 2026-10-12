import {it,expect} from 'vitest';
import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
import {migrationPage} from '../../lib/server/migration';
it('exports data only from the selected organization, retaining only current snapshot observations',async()=>{
 const c=createClient({url:'file::memory:'});for(const f of readdirSync('drizzle').filter(x=>x.endsWith('.sql')))await c.executeMultiple(readFileSync(`drizzle/${f}`,'utf8'));const s=new Store(sqliteBindings(c));
 for(const org of ['inside','outside'])await s.run('INSERT INTO organizations VALUES(?,?,1)',org,org);
 const batch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-12',dataset:'overview',metric:'revenue',value:20,dimensions:{},definition:'web',currency:'USD'}]} as any;
 await s.persistBatch('inside','source',batch,'old','2026-10-12T00:00:00Z');await s.persistBatch('inside','source',batch,'current','2026-10-12T01:00:00Z');await s.persistBatch('outside','source',batch,'outside','2026-10-12T01:00:00Z');
 expect((await migrationPage(s,'inside','organizations')).rows.map(x=>x.id)).toEqual(['inside']);const snapshots=(await migrationPage(s,'inside','snapshots')).rows;expect(snapshots).toHaveLength(1);expect(snapshots[0].id).toContain('current');expect((await migrationPage(s,'inside','observations')).rows).toHaveLength(1);
 await expect(migrationPage(s,'inside','sqlite_master')).rejects.toThrow('table');await expect(migrationPage(s,'inside','organizations',-1)).rejects.toThrow('cursor');c.close();
});
