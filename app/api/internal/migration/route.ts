import {timingSafeEqual} from 'node:crypto';
import {env,runtimePlatform} from '@avenue/runtime';
import {serverSecret} from '../../../../lib/server/secrets';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {getStore,requireClientAccess} from '../../../../lib/server/access';
import {migrationPage,migrationTables} from '../../../../lib/server/migration';
// Temporary, read-only transfer endpoint. Both the private Sites boundary and
// a separately configured migration secret are required. Absent on Vercel.
export async function GET(request:Request){
 const secret=serverSecret('MIGRATION_EXPORT_SECRET'),received=request.headers.get('x-avenue-migration');
 if(runtimePlatform!=='sites'||!secret||secret.length<32||!received||Buffer.byteLength(secret)!==Buffer.byteLength(received)||!timingSafeEqual(Buffer.from(secret),Buffer.from(received)))return Response.json({error:'Unavailable'},{status:404});
 try{
  const identity=await getChatGPTUser();if(identity)await requireClientAccess(undefined,true);
  const s=getStore(),org='avenue-z',params=new URL(request.url).searchParams,table=params.get('table');
  if(params.get('transfer')==='credentials')return Response.json({OPENAI_API_KEY:serverSecret('OPENAI_API_KEY'),SOURCE_KIND_PATCHES_SCRIPT:serverSecret('SOURCE_KIND_PATCHES_SCRIPT')},{headers:{'Cache-Control':'no-store'}});
  if(params.get('snapshotId')){const snapshot=await s.first('SELECT id,sourceId,objectKey FROM snapshots WHERE id=? AND organizationId=?',params.get('snapshotId'),org);if(!snapshot)return Response.json({error:'Unavailable'},{status:404});const bucket=env.BUCKET as unknown as {get:(key:string)=>Promise<{text:()=>Promise<string>}|null>};let object=await bucket.get(snapshot.objectKey);const hash=snapshot.id.split(':').at(-1);if(!object&&snapshot.sourceId.startsWith('archive-')&&/^[a-f0-9]{64}$/.test(hash))object=await bucket.get(`imports/${hash}.json`);if(!object)return Response.json({error:'Archive object missing'},{status:404});return new Response(await object.text(),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
  if(!table){const tables=[];for(const name of migrationTables){const present=await s.first("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name);if(present)tables.push(name);}return Response.json({organizationId:org,tables},{headers:{'Cache-Control':'no-store'}});}
  return Response.json(await migrationPage(s,org,table,Number(params.get('cursor')||0)),{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Migration transfer failed'},{status:403});}
}
