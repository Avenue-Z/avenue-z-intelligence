import {createClient} from '@libsql/client';

// Read-only operational check. Run with the existing server environment, e.g.
// node --env-file=.sites-runtime/vercel-production.env scripts/verify-autobrush-readiness.mjs
const organizationId=process.env.APP_ORGANIZATION_ID||'avenue-z',clientId='autobrush';
const requiredProviders=['shopify','loop','meta','motion','intelligems','northbeam','ga4'];
const checkedAt=new Date().toISOString();
const configured=process.env.TURSO_DATABASE_URL&&process.env.TURSO_AUTH_TOKEN;
const stringList=value=>Array.isArray(value)&&value.every(item=>typeof item==='string');
// These are recorded requirements, not live provider qualification or data-coverage certification.
function storedRequirementsPass(row,source,client){
 if(!row||row.connectionVersion!==source.version||row.clientVersion!==client.version)return false;
 try{
  const q=JSON.parse(row.payload);
  return q.clientId===client.id&&q.timezone===client.timezone&&q.currency===client.currency&&
   q.paginationComplete===true&&q.reconciled===true&&typeof q.hourlyGrain==='boolean'&&
   (q.requiresHourly===undefined||typeof q.requiresHourly==='boolean')&&(!q.requiresHourly||q.hourlyGrain)&&
   stringList(q.channels)&&stringList(q.requiredChannels)&&q.requiredChannels.every(value=>q.channels.includes(value))&&
   stringList(q.dimensions)&&stringList(q.requiredDimensions)&&q.requiredDimensions.every(value=>q.dimensions.includes(value));
 }catch{return false;}
}
if(!configured){console.log(JSON.stringify({clientId,checkedAt,setupChecksPassed:false,handoverVerified:false,error:'Database service credentials are not configured'}));process.exitCode=2;}
else{
 let db;
 try{
  db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN,fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([init?.signal??new AbortController().signal,AbortSignal.timeout(15000)])})});
  const read=async(sql,...args)=>(await db.execute({sql,args})).rows;
  const [client]=await read('SELECT id,name,timezone,currency,version FROM clients WHERE organizationId=? AND id=?',organizationId,clientId);
  if(!client){
   console.log(JSON.stringify({clientId,checkedAt,setupChecksPassed:false,handoverVerified:false,registered:false,providers:requiredProviders.map(provider=>({provider,state:'not-registered',scheduledIngestionRecorded:false})),next:'Verify authenticated store identity and connect the provider accounts before activation'},null,2));process.exitCode=2;
  }else{
   const [connections,grants,history,reviews]=await Promise.all([
    read('SELECT id,provider,enabled,lastSuccess,coverageThrough,pollMinutes,version FROM connections WHERE organizationId=? AND clientId=?',organizationId,clientId),
    read('SELECT provider,updatedAt FROM provider_credentials WHERE organizationId=? AND clientId=?',organizationId,clientId),
    read('SELECT sourceId,MIN(date) AS earliest,MAX(date) AS latest,COUNT(*) AS storedDays FROM current_snapshots WHERE organizationId=? AND clientId=? GROUP BY sourceId',organizationId,clientId),
    read('SELECT storeDate,createdAt FROM reviews WHERE organizationId=? AND clientId=? AND current=1 ORDER BY storeDate DESC LIMIT 1',organizationId,clientId)
   ]);
   const sourceChecks=await Promise.all(connections.map(async source=>{
    const [qualification]=await read('SELECT connectionVersion,clientVersion,payload FROM qualifications WHERE organizationId=? AND clientId=? AND sourceId=? ORDER BY version DESC LIMIT 1',organizationId,clientId,source.id);
    const storedQualificationRequirementsPass=storedRequirementsPass(qualification,source,client);
    const ageMinutes=source.lastSuccess?(Date.parse(checkedAt)-Date.parse(source.lastSuccess))/60000:null;
    const refreshOnSchedule=ageMinutes!==null&&Number.isFinite(ageMinutes)&&ageMinutes>=-5&&ageMinutes<=Math.min(Math.max(Number(source.pollMinutes)||60,1),60)+15;
    return {...source,enabled:source.enabled===1,storedQualificationRequirementsPass,refreshOnSchedule,history:history.find(row=>row.sourceId===source.id)??null};
   }));
   const providers=requiredProviders.map(provider=>{
    const sources=sourceChecks.filter(source=>source.provider===`autobrush-${provider}`||source.provider.startsWith(`autobrush-${provider}-`));
    const grant=grants.find(row=>row.provider===provider);
    const scheduledIngestionRecorded=sources.length>0&&sources.every(source=>source.enabled&&source.storedQualificationRequirementsPass&&source.refreshOnSchedule&&source.history?.storedDays>0);
    return {provider,state:scheduledIngestionRecorded?'scheduled-ingestion-recorded':sources.length?'setup-incomplete':grant?'authorization-stored':'not-connected',scheduledIngestionRecorded,authorizationStored:!!grant,sources};
   });
   console.log(JSON.stringify({clientId,checkedAt,registered:true,client,setupChecksPassed:providers.every(provider=>provider.scheduledIngestionRecorded),handoverVerified:false,providers,latestReview:reviews[0]??null,note:'Stored setup diagnostic only. Recent polling does not prove fresh data. Actual authorization, complete source qualification, provider coverage, thirty-day history and reconciled figures require separate live handover checks.'},null,2));
   // Never return successful handover certification from metadata alone.
   process.exitCode=2;
  }
 }catch{console.log(JSON.stringify({clientId,checkedAt,setupChecksPassed:false,handoverVerified:false,error:'Read-only readiness query failed; no connection or credential was changed'}));process.exitCode=1;}
 finally{db?.close();}
}
