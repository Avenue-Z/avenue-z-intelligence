import {createClient} from '@libsql/client';
import {Store} from './store';
import {sqliteBindings} from './sqlite-bindings';
import {createDatabaseFetch} from './database-fetch';
import {serverSecret} from './secrets';
import {runBeamSync} from '../jobs/beam-sync';
import {cacheTick} from '../jobs/cache-runner';
/** Each native invocation owns its RPC client and closes unfinished requests. */
export async function beamCron(history:boolean|'cache'=false){
 const url=serverSecret('TURSO_DATABASE_URL'),authToken=serverSecret('TURSO_AUTH_TOKEN');if(!url||!authToken)throw Error('Shared database service credential is not configured');
 const client=createClient({url,authToken,fetch:createDatabaseFetch()});
 try{const store=new Store(sqliteBindings(client));return history==='cache'?await cacheTick('beam',store):await runBeamSync(store,serverSecret('APP_ORGANIZATION_ID')||'avenue-z',history);}
 finally{client.close();}
}
