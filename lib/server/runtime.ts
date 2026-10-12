import {env as siteEnv} from 'cloudflare:workers';
import {createClient} from '@libsql/client/web';
import {sqliteBindings} from './sqlite-bindings';
import {selectSharedDatabase} from './shared-database';
let database:unknown;
export const env=new Proxy(siteEnv,{get(target,key){
 if(key==='DB')return database??=selectSharedDatabase(target as unknown as {DB:unknown;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown},input=>sqliteBindings(createClient(input)));
 return Reflect.get(target,key);
}});
export const runtimePlatform='sites' as string;
