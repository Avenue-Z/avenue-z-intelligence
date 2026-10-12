import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect} from 'vitest';
import {Store} from '../../lib/server/store';
import {DailyScheduler,dueReview} from '../../lib/jobs/scheduler';
import initialClients from '../../data/initial-clients.json';
import type {Client} from '../../lib/analytics/contracts';

function store(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const prepare=(sql:string)=>{let values:any[]=[];const api={bind(...v:any[]){values=v;return api;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return api;};
 return new Store({prepare,batch:async ss=>Promise.all(ss.map(s=>s.run()))});
}
const kind=initialClients[0] as unknown as Client,beam=initialClients[1] as unknown as Client;
it('runs at 9 ET across DST while choosing each brand store date',()=>{
 expect(dueReview(kind,new Date('2026-10-12T12:59:00Z'))).toBeNull();
 expect(dueReview(kind,new Date('2026-10-12T13:00:00Z'))).toMatchObject({storeDate:'2026-10-12',mode:'partial'});
 expect(dueReview(beam,new Date('2026-10-12T13:00:00Z'))).toMatchObject({storeDate:'2026-10-11',mode:'closed'});
 expect(dueReview(kind,new Date('2026-11-02T13:59:00Z'))).toBeNull();
 expect(dueReview(kind,new Date('2026-11-02T14:00:00Z'))).not.toBeNull();
});
it('keeps the store date anchored to the review slot after Stockholm midnight',()=>{
 expect(dueReview(kind,new Date('2026-10-12T22:05:00Z'))).toMatchObject({storeDate:'2026-10-12',mode:'partial'});
 expect(dueReview(kind,new Date('2026-10-13T13:00:00Z'))).toMatchObject({storeDate:'2026-10-13',mode:'partial'});
});
it('can recover an existing job after reporting midnight until the next slot arrives',()=>{
 expect(dueReview(kind,new Date('2026-10-13T04:05:00Z'),true)).toMatchObject({storeDate:'2026-10-12'});
});
it('keeps a global lease durable, refuses overlap, and recovers a crashed run',async()=>{
 const s=store(),a=new DailyScheduler(s),b=new DailyScheduler(s),now='2026-10-12T13:00:00Z';
 const token=await a.acquire('org:sync',now);expect(token).toBeTruthy();
 expect(await b.acquire('org:sync','2026-10-12T13:01:00Z')).toBeNull();
 expect(await b.acquire('org:sync','2026-10-12T13:07:00Z')).toBeTruthy();
 await a.release('org:sync',token!);
 expect(await a.acquire('org:sync','2026-10-12T13:08:00Z')).toBeNull();
});
it('deduplicates a daily report across ticks and restarts after completion',async()=>{
 const s=store(),a=new DailyScheduler(s),now='2026-10-12T13:00:00Z';
 const due=dueReview(kind,new Date(now))!;
 await a.enqueue('o',kind.id,due,now);await a.enqueue('o',kind.id,due,now);
 const j=await a.claim('o',now);expect(j).not.toBeNull();
 expect(await a.claim('o',now)).toBeNull();
 await a.complete(j!,'report-id',now);
 await new DailyScheduler(s).enqueue('o',kind.id,due,'2026-10-12T14:00:00Z');
 expect(await a.claim('o','2026-10-12T14:00:00Z')).toBeNull();
 expect((await s.all('SELECT * FROM scheduled_reviews'))).toHaveLength(1);
});
it('persists delayed retries and prevents an expired worker overwriting its replacement',async()=>{
 const s=store(),a=new DailyScheduler(s),now='2026-10-12T13:00:00Z';await a.enqueue('o',kind.id,dueReview(kind,new Date(now))!,now);
 const old=await a.claim('o',now),replacement=await a.claim('o','2026-10-12T13:07:00Z');expect(replacement).not.toBeNull();
 await a.complete(old!,'stale-report',now);expect((await s.first('SELECT * FROM scheduled_reviews')).status).toBe('running');
 await a.fail(replacement!,'temporary', '2026-10-12T13:07:00Z');
 expect(await a.claim('o','2026-10-12T13:08:00Z')).toBeNull();
 expect(await new DailyScheduler(s).claim('o','2026-10-12T13:20:00Z')).not.toBeNull();
 expect(await a.claim('other','2026-10-12T14:00:00Z')).toBeNull();
});
