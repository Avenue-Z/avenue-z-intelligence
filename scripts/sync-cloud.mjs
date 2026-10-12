// Manual operational probe. Production scheduling belongs to vercel.json.
const origin=process.env.APP_ORIGIN;
const serviceSecret=process.env.CRON_SECRET;
if(!origin||!serviceSecret)throw new Error('Configure APP_ORIGIN and CRON_SECRET in the server environment.');
const url=new URL('/api/cron/sync',origin);
if(url.protocol!=='https:')throw new Error('Cloud synchronization requires HTTPS');
const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(300000),headers:{authorization:`Bearer ${serviceSecret}`}});
if(!response.ok)throw new Error(`Synchronization returned HTTP ${response.status}`);
const result=await response.json();
console.log(JSON.stringify({completed:result.completed?.length??0,failed:result.failed?.length??0}));
if(result.failed?.length)process.exitCode=1;
