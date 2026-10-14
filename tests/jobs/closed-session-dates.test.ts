import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {closedSessionDatesToSkip} from '../../lib/jobs/closed-session-dates';
import {dayWindow} from '../../lib/analytics/windows';
import type {Client,Connection,Observation} from '../../lib/analytics/contracts';
import {kindQualification,sourceBatch} from '../../lib/sources/kind-patches';
import initial from '../../data/initial-clients.json';

const client={...initial[0],version:1} as Client,date='2026-10-13',today='2026-10-14',now=new Date('2026-10-14T13:00:00Z'),window=dayWindow(date,client.timezone);
const source={id:'source',clientId:client.id,provider:'kind-shopify-hourly',lastSuccess:'2026-10-14T12:00:00Z',version:1} as Connection;
const fact:Observation={date,sourceId:source.id,dataset:'overview',metric:'sessions',value:7,definition:'shopify_human_sessions',population:'human_online_store_sessions',currency:null,dimensions:{},quality:'complete',retrievedAt:'2026-10-14T00:00:00Z',coverageThrough:window.end,start:window.start,end:'2026-10-12T23:00:00Z'};
const contract=kindQualification(sourceBatch(client,[fact],window.end,[],'hourly'),source.provider);
let store:Store,sqlite:DatabaseSync;
beforeEach(async()=>{
 sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as SQLInputValue[])};},async first(){return sqlite.prepare(sql).get(...values as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as SQLInputValue[]).changes)}};}};return statement;};
 store=new Store({prepare,batch:statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('capture','o','kind-patches','source',?,?,1,'ready','private')",fact.retrievedAt,window.end);
 await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId,publishedAt) VALUES('o','kind-patches','source',?,'capture','2026-10-14T00:00:00Z')",date);
 await store.run("INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES('capture',?,'first',?)",date,JSON.stringify(fact));
});
afterEach(()=>{vi.restoreAllMocks();sqlite.close();});
const select=(connection=source,profile=contract,automatic=true,asOf=now)=>closedSessionDatesToSkip(store,'o',client,connection,profile,[today,date,'2026-10-07'],asOf,automatic);
it.each(['kind-shopify-hourly','kind-shopify-funnels'] as const)('reuses a scoped settled complete %s day without observation-range reads or writes',async provider=>{
 const writes=vi.spyOn(store,'run'),read=vi.spyOn(store,'all');
 expect([...await select({...source,provider})]).toEqual([date]);expect(writes).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
 expect(read.mock.calls[0][0]).toContain('ORDER BY o.rowKey LIMIT 1');
});
it.each(['kind-triple-whale','kind-triple-whale-diagnostics','kind-shopify-traffic'] as const)('retains the existing %s correction policy',async provider=>{expect([...await select({...source,provider})]).toEqual([]);});
it('keeps initialization and manual captures intact without reading stored facts',async()=>{const read=vi.spyOn(store,'all');expect([...await select({...source,lastSuccess:null})]).toEqual([]);expect([...await select(source,contract,false)]).toEqual([]);expect(read).not.toHaveBeenCalled();});
it('never treats another tenant, client or source as an existing comparison capture',async()=>{
 for(const [column,value] of [['organizationId','other'],['clientId','other'],['sourceId','other']]){await store.run(`UPDATE current_snapshots SET ${column}=?`,value);expect([...await select()]).toEqual([]);await store.run(`UPDATE current_snapshots SET ${column}=?`,column==='organizationId'?'o':column==='clientId'?'kind-patches':'source');}
});
it.each([
 ["UPDATE snapshots SET status='writing'"],
 ["UPDATE snapshots SET complete=0"],
 ["UPDATE snapshots SET coverageThrough='2026-10-13T21:00:00Z'"],
 ["UPDATE snapshots SET coverageThrough='invalid'"],
 ["UPDATE current_snapshots SET publishedAt='2026-10-13T23:29:59.999Z'"],
 ["UPDATE current_snapshots SET publishedAt='2026-10-15T00:00:00Z'"],
 ["UPDATE current_snapshots SET publishedAt='invalid'"],
 ["UPDATE snapshots SET sourceId='other'"],
 ["DELETE FROM observations"]
])('retains capture work when canonical metadata cannot prove a settled complete day: %s',async sql=>{await store.run(sql);expect([...await select()]).toEqual([]);});
it.each([
 {sourceId:'other'}, {date:'2026-10-12'}, {quality:'partial'}, {start:undefined,end:undefined},
 {start:'2026-10-12T23:00:00Z',end:'2026-10-13T00:00:00Z'}, {end:'2026-10-13T01:00:00Z'},
 {end:window.start}, {definition:'legacy'}, {population:'bots'}, {currency:'USD'}, {dimensions:{market:'US'}},
 {metric:'unregistered'}, {value:null}, {coverageThrough:'2026-10-13T21:00:00Z'}
])('retains legacy or mismatched first facts: %j',async changes=>{await store.run("UPDATE observations SET payload=?",JSON.stringify({...fact,...changes}));expect([...await select()]).toEqual([]);});
it('accepts the 90-minute settling boundary exactly, and keeps the recently closed midnight fallback',async()=>{
 await store.run("UPDATE current_snapshots SET publishedAt='2026-10-13T23:30:00Z'");
 expect([...await select(source,contract,true,new Date('2026-10-13T23:30:00Z'))]).toEqual([date]);
 expect([...await select(source,contract,true,new Date('2026-10-13T22:30:00Z'))]).toEqual([]);
});
it('never skips today even if corrupted metadata claims it already covers the entire day',async()=>{const live=dayWindow(today,client.timezone);await store.run('UPDATE current_snapshots SET date=?,publishedAt=?',today,live.end);await store.run('UPDATE snapshots SET coverageThrough=?',live.end);expect([...await select()]).toEqual([]);});
it('requires the current qualified hourly contract',async()=>{expect([...await select(source,{...contract,hourlyGrain:false})]).toEqual([]);expect([...await select(source,{...contract,profiles:contract.profiles.map(profile=>({...profile,hourly:false}))})]).toEqual([]);});
it('falls back to normal source capture when optional canonical metadata cannot be read',async()=>{
 vi.spyOn(store,'all').mockRejectedValue(new DOMException('Database request timed out','TimeoutError'));
 expect([...await select()]).toEqual([]);
});
