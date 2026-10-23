import {createClient} from '@libsql/client';
import {Store} from './store';
import {sqliteBindings} from './sqlite-bindings';
import {createDatabaseFetch} from './database-fetch';
import {serverSecret} from './secrets';
import {runAutobrushSync} from '../jobs/autobrush-sync';
import {cacheTick} from '../jobs/cache-runner';
/** Each native invocation owns its RPC client and closes unfinished requests. */
export async function withAutobrushStore<T>(work:(store:Store)=>Promise<T>){
 const url=serverSecret('TURSO_DATABASE_URL'),authToken=serverSecret('TURSO_AUTH_TOKEN');if(!url||!authToken)throw Error('Shared database service credential is not configured');
 const client=createClient({url,authToken,fetch:createDatabaseFetch()});
 try{return await work(new Store(sqliteBindings(client)));}
 finally{client.close();}
}
export async function autobrushCron(history:boolean|'cache'=false){return withAutobrushStore(store=>history==='cache'?cacheTick('autobrush',store):runAutobrushSync(store,serverSecret('APP_ORGANIZATION_ID')||'avenue-z',history));}
