import {timingSafeEqual} from 'node:crypto';
import {serverSecret} from './secrets';
export async function cronRequest(request:Request,run:()=>Promise<{failed:unknown[];[key:string]:unknown}>){
 const secret=serverSecret('CRON_SECRET'),received=request.headers.get('authorization');
 const expected=secret?`Bearer ${secret}`:'';
 if(!secret||secret.length<32||!received||Buffer.byteLength(received)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return Response.json({error:'Unauthorized'},{status:401,headers:{'cache-control':'no-store'}});
 try{const result=await run();return Response.json(result,{status:result.failed.length?500:200,headers:{'cache-control':'no-store'}});}
 catch{return Response.json({error:'Scheduled job failed; inspect application job status'},{status:500,headers:{'cache-control':'no-store'}});}
}
