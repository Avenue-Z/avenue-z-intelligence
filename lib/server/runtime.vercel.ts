import {createClient} from '@libsql/client';
import {put} from '@vercel/blob';
import {sqliteBindings} from './sqlite-bindings';
import {createDatabaseFetch} from './database-fetch';
export const runtimePlatform='vercel' as string;
let database:ReturnType<typeof sqliteBindings>|undefined;
const bucket={async put(key:string,body:string,options?:{httpMetadata?:{contentType?:string}}){
 if(!process.env.BLOB_READ_WRITE_TOKEN)throw new Error('Private snapshot archive is not configured');
 return put(key,body,{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:options?.httpMetadata?.contentType??'application/json'});
}};
// Bind lazily: build/static analysis needs no production credentials.
export const env=new Proxy({} as {DB:ReturnType<typeof sqliteBindings>;BUCKET:typeof bucket;[key:string]:unknown},{get(_target,key){
 if(key==='DB'){
  if(!process.env.TURSO_DATABASE_URL)throw new Error('Shared database is not configured');
  if(process.env.VERCEL&&!process.env.TURSO_AUTH_TOKEN)throw new Error('Shared database service credential is not configured');
  return database??=sqliteBindings(createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN,fetch:createDatabaseFetch()}));
 }
 if(key==='BUCKET')return bucket;
 return typeof key==='string'?process.env[key]:undefined;
}});
