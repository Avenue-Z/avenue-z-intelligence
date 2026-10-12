import {env as siteEnv} from 'cloudflare:workers';
import {createClient} from '@libsql/client/web';
import {sqliteBindings} from './sqlite-bindings';
import {selectSharedDatabase} from './shared-database';
type SitesDatabase={prepare:(...args:any[])=>any;batch:(...args:any[])=>any};
let database:unknown;
function requestSafeDatabase(bindings:{DB:unknown;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown}){
 const selected=selectSharedDatabase(bindings,input=>sqliteBindings(createClient(input))) as SitesDatabase;
 // Worker requests own their I/O lifetimes. Reuse completed serialized cache
 // entries while keeping pending promises inside their originating request.
 return {prepare:selected.prepare.bind(selected),batch:selected.batch.bind(selected),allowCrossRequestCoalescing:false as const};
}
export const env=new Proxy(siteEnv,{get(target,key){
 if(key==='DB')return database??=requestSafeDatabase(target as unknown as {DB:unknown;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown});
 return Reflect.get(target,key);
}});
export const runtimePlatform='sites' as string;
