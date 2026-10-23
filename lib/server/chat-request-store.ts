import {runtimePlatform} from '@avenue/runtime';
import {createClient} from '@libsql/client';
import {Store} from './store';
import {sqliteBindings} from './sqlite-bindings';
import {createDatabaseFetch} from './database-fetch';
import {serverSecret} from './secrets';

/** Native chat owns one SDK for its complete authorization/read/write flow. */
export async function withChatRequestStore<T>(work:(store?:Store)=>Promise<T>):Promise<T>{
 if(runtimePlatform!=='vercel')return work();
 const url=serverSecret('TURSO_DATABASE_URL'),authToken=serverSecret('TURSO_AUTH_TOKEN');
 if(!url||!authToken)throw Error('Shared database service credential is not configured');
 const client=createClient({url,authToken,fetch:createDatabaseFetch()});
 try{return await work(new Store(sqliteBindings(client)));}
 finally{client.close();}
}
