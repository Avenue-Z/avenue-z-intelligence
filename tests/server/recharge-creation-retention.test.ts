import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import {retainedRechargeCreations} from '../../lib/server/recharge-creation-retention';
import type {AccessScope,Client} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';

const client=initial[0] as Client;
const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:[client.id]};
const window={from:'2026-10-14',to:'2026-10-15'};
function setup(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let args:unknown[]=[];const statement={bind(...values:unknown[]){args=values;return statement;},async all(){return {results:sqlite.prepare(sql).all(...args as (string|number|null)[])};},async first(){return sqlite.prepare(sql).get(...args as (string|number|null)[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as (string|number|null)[]).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 function insert(id:string,createdAt:string,options:{org?:string;clientId?:string;payload?:unknown;recordId?:string;action?:string}={}){
  const org=options.org??'o',clientId=options.clientId??client.id,payload=options.payload??{subscriptionId:id,createdAt,receivedAt:'2026-10-15T14:00:00Z',source:'recharge-webhook',topic:'subscription/created'};
  sqlite.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(options.recordId??`recharge-creation:${org}:${clientId}:${id}`,org,clientId,'recharge-webhook',options.action??'recharge.subscription.creation.retained',JSON.stringify(payload),'2026-10-15T14:00:00Z');
 }
 return {store,sqlite,insert};
}
it('reuses only authenticated retained resource births in the requested Stockholm calendar window and tenant',async()=>{
 const {store,insert}=setup();
 insert('1','2026-10-13T22:00:00Z');insert('2','2026-10-15T21:59:59Z');
 insert('3','2026-10-13T21:59:59Z');insert('4','2026-10-15T22:00:00Z');
 insert('5','2026-10-14T10:00:00Z',{org:'other'});insert('6','2026-10-14T10:00:00Z',{clientId:'beam'});
 insert('7','2026-10-14T10:00:00Z',{action:'other-action'});
 expect(await retainedRechargeCreations(store,scope,client,window,Date.now()+10000)).toEqual([{subscriptionId:'1',createdAt:'2026-10-13T22:00:00Z'},{subscriptionId:'2',createdAt:'2026-10-15T21:59:59Z'}]);
});
it('reads every retained birth over multiple bounded pages',async()=>{
 const {store,insert}=setup();
 for(let id=1;id<=2001;id++)insert(String(id),'2026-10-14T10:00:00Z');
 const rows=await retainedRechargeCreations(store,scope,client,window,Date.now()+20000);
 expect(rows).toHaveLength(2001);expect(new Set(rows.map(row=>row.subscriptionId)).size).toBe(2001);
});
it('keeps exact resource births immediately before midnight despite SQLite date rounding',async()=>{
 const {store,insert}=setup();
 insert('1','2026-10-13T21:59:59.999999999Z');insert('2','2026-10-13T22:00:00Z');
 insert('3','2026-10-15T21:59:59.999999999Z');insert('4','2026-10-15T22:00:00Z');
 expect((await retainedRechargeCreations(store,scope,client,window,Date.now()+10000)).map(row=>row.subscriptionId)).toEqual(['2','3']);
});
it.each([
 {subscriptionId:'1',createdAt:'invalid',receivedAt:'2026-10-15T14:00:00Z',source:'recharge-webhook',topic:'subscription/created'},
 {subscriptionId:'2',createdAt:'2026-10-14T10:00:00Z',receivedAt:'2026-10-15T14:00:00Z',source:'recharge-webhook',topic:'subscription/created'},
 {subscriptionId:'1',createdAt:'2026-10-14T10:00:00Z',receivedAt:'2026-10-15T14:00:00Z',source:'unverified-import',topic:'subscription/created'},
 {subscriptionId:'1',createdAt:'2026-10-14T10:00:00Z',receivedAt:'invalid',source:'recharge-webhook',topic:'subscription/created'},
 {subscriptionId:'1',createdAt:'2026-10-14T10:00:00Z',receivedAt:'2026-10-15T14:00:00Z',source:'recharge-webhook',topic:'other/topic'}
])('rejects untrusted or corrupt retained birth evidence instead of publishing a smaller denominator',async payload=>{
 const {store,insert}=setup();insert('1','2026-10-14T10:00:00Z',{payload});
 await expect(retainedRechargeCreations(store,scope,client,window,Date.now()+10000)).rejects.toThrow('Retained Recharge creation');
});
it('keeps identity evidence internal and returns only the creation fields needed by the source',async()=>{
 const {store,insert}=setup();insert('1','2026-10-14T10:00:00Z');
 const rows=await retainedRechargeCreations(store,scope,client,window,Date.now()+10000);
 expect(Object.keys(rows[0]).sort()).toEqual(['createdAt','subscriptionId']);expect(JSON.stringify(rows)).not.toContain('receivedAt');
});
it('rejects unauthorized scopes and expired budgets before reading evidence',async()=>{
 const {store}=setup();
 await expect(retainedRechargeCreations(store,{...scope,permittedClientIds:[]},client,window,Date.now()+10000)).rejects.toThrow('access');
 await expect(retainedRechargeCreations(store,{...scope,role:'analyst'},client,window,Date.now()+10000)).rejects.toThrow('access');
 await expect(retainedRechargeCreations(store,scope,client,window,Date.now()-1)).rejects.toThrow('deadline');
});
