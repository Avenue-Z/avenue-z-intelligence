// Run in an authorized hosted scheduler. Browser sessions are never needed.
const origin=process.env.SITE_ORIGIN;
const runner=process.env.RUNNER_SECRET;
const dispatch=process.env.SITE_DISPATCH_TOKEN;
if(!origin||!runner||!dispatch)throw new Error('Configure SITE_ORIGIN, RUNNER_SECRET, and SITE_DISPATCH_TOKEN as scheduler secrets');
const url=new URL('/api/internal/sync',origin);
if(url.protocol!=='https:')throw new Error('Cloud synchronization requires HTTPS');
const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{Authorization:`Bearer ${runner}`,'OAI-Sites-Authorization':dispatch}});
if(!response.ok)throw new Error(`Synchronization returned HTTP ${response.status}`);
const result=await response.json();
console.log(JSON.stringify({completed:result.completed?.length??0,failed:result.failed?.length??0}));
if(result.failed?.length)process.exitCode=1;
