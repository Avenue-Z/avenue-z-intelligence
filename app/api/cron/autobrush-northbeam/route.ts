import {createClient} from '@libsql/client';
import {cronRequest} from '../../../../lib/server/cron';
import {Store} from '../../../../lib/server/store';
import {sqliteBindings} from '../../../../lib/server/sqlite-bindings';
import {createDatabaseFetch} from '../../../../lib/server/database-fetch';
import {serverSecret} from '../../../../lib/server/secrets';
import {createAutobrushNorthbeamSync} from '../../../../lib/jobs/autobrush-northbeam-sync';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request){return cronRequest(request,async()=>{
 let client:ReturnType<typeof createClient>|undefined,store:Store|undefined;
 const getStore=()=>{
  if(store)return store;const url=serverSecret('TURSO_DATABASE_URL'),authToken=serverSecret('TURSO_AUTH_TOKEN');
  if(!url||!authToken)throw Error('Shared database service credential is not configured');
  client=createClient({url,authToken,fetch:createDatabaseFetch()});return store=new Store(sqliteBindings(client));
 };
 try{return await createAutobrushNorthbeamSync({store:getStore,secret:serverSecret})();}finally{client?.close();}
});}
