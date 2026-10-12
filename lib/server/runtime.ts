import {env as siteEnv} from 'cloudflare:workers';
import {createClient} from '@libsql/client/web';
import {sqliteBindings} from './sqlite-bindings';
import {selectSharedDatabase} from './shared-database';
type SitesDatabase={prepare:(...args:any[])=>any;batch:(...args:any[])=>any};
function requestSafeDatabase(bindings:{DB:unknown;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown}){
 const selected=selectSharedDatabase(bindings,input=>sqliteBindings(createClient(input))) as SitesDatabase;
 // Worker requests own their I/O lifetimes. A cancelled request can abandon
 // the SDK client's pending I/O and limiter slots, so clients cannot be global.
 return {prepare:selected.prepare.bind(selected),batch:selected.batch.bind(selected),allowCrossRequestCoalescing:false as const};
}
export const env=new Proxy(siteEnv,{get(target,key){
 if(key==='DB')return requestSafeDatabase(target as unknown as {DB:unknown;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown});
 return Reflect.get(target,key);
}});
export const runtimePlatform='sites' as string;
