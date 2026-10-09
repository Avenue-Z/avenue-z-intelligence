// Run in an authorized hosted scheduler. Browser sessions are never needed.
const origin=process.env.SITE_ORIGIN;
const dispatch=process.env.SITE_DISPATCH_TOKEN;
if(!origin||!dispatch)throw new Error('Configure SITE_ORIGIN and SITE_DISPATCH_TOKEN as scheduler secrets. Obtain fresh service access from the linked native Sites connection; do not hardcode it.');
const url=new URL('/api/internal/sync',origin);
if(url.protocol!=='https:')throw new Error('Cloud synchronization requires HTTPS');
const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(150000),headers:{'OAI-Sites-Authorization':`Bearer ${dispatch}`}});
if(!response.ok)throw new Error(`Synchronization returned HTTP ${response.status}`);
const result=await response.json();
console.log(JSON.stringify({completed:result.completed?.length??0,failed:result.failed?.length??0}));
if(result.failed?.length)process.exitCode=1;
