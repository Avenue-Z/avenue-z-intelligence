import {getStore,requireClientAccess} from '../server/access';
import {parseFilters} from '../server/workspace';
import {queryClient} from '../analytics/query';
import {fingerprint} from '../reviews/build';
import {serverSecret} from '../server/secrets';
import {buildAIContext,compactAIContextForModel,restoreAIContextSnapshot,validateAnswer,reviewSchema,REVIEW_SECTIONS} from './context';
import {askOpenAI} from './provider';
import type {QueryFilters,AccessScope} from '../analytics/contracts';
import type {Store,ScheduledReviewLease} from '../server/store';
import {Temporal} from '@js-temporal/polyfill';
import {supplementalReviewEvidence} from './evidence';
import {shiftDate} from '../analytics/windows';
import {evidenceReviewTables} from '../reviews/tables';
import {authoritativeSpendReview} from '../reviews/spend-review';
import {refineReview,rankedReviewPages} from '../reviews/refine';
import {boundedAIContextForModel} from './model-input';
import {buildChatModelContext} from './chat-input';
import {withAnalyticsMemory} from '../server/analytics-memory';
import {chatDatasets,chatNeedsMonthHistory,chatNeedsReviewBody,chatObservationSelection} from './chat-scope';
import {monthToDateSummary} from '../analytics/month-to-date';
const reviewHistoryDatasets=['overview','subscriptions','subscriptionEvents','revenue','markets','media','orderStreams','renewalDiagnostics','orderHygiene'];
const reviewDetailDatasets=['funnels','traffic','products','discounts','creatives','experiments'];
export async function aiContext(clientId:string|undefined,filters:QueryFilters,reviewId?:string,existingScope?:AccessScope,sourceOnly=false,fastChat=false,question=''){
 const compute=()=>aiContextWithinBudget(clientId,filters,reviewId,existingScope,sourceOnly,fastChat,question);
 const dimensional=!fastChat||chatDatasets(filters.view,question).some(dataset=>['funnels','traffic','products','creatives','experiments'].includes(dataset));
 return dimensional?withAnalyticsMemory(compute):compute();
}
async function aiContextWithinBudget(clientId:string|undefined,filters:QueryFilters,reviewId?:string,existingScope?:AccessScope,sourceOnly=false,fastChat=false,question=''){
 filters=parseFilters(new URLSearchParams({...filters}));
 const scope=existingScope??await requireClientAccess(clientId),s=getStore();if(clientId&&!scope.permittedClientIds.includes(clientId))throw new Error('Client access denied');
 const clients=(await s.clients(scope.organizationId)).filter(c=>scope.permittedClientIds.includes(c.id)&&(!clientId||c.id===clientId));
 if(reviewId&&!clientId)throw new Error('Client identity required for a review');
 if(reviewId&&clientId){
  const saved=await s.first("SELECT id,storeDate,revision,json_extract(payload,'$.evidence') AS evidence,json_remove(payload,'$.evidence') AS payload FROM reviews WHERE organizationId=? AND clientId=? AND id=?",scope.organizationId,clientId,reviewId);
  if(!saved)throw new Error('Review access denied');
  if(saved.evidence){const context=restoreAIContextSnapshot(JSON.parse(saved.evidence));if(context.clients?.length!==1||context.clients[0].client.id!==clientId||context.filters?.to!==saved.storeDate)throw new Error('Saved review evidence scope is invalid');
   const c=context.clients[0],payload=JSON.parse(saved.payload),sourceId=`review:${saved.id}`;c.selectedReview={storeDate:saved.storeDate,revision:saved.revision};
   c.sourceReviews=[{sourceId,storeDate:saved.storeDate,revision:saved.revision,scopeLabel:'Fixed saved report and its original evidence; subsequent provider refreshes are outside this report.',payload:{type:payload.type,text:payload.text,kpis:payload.kpis,summary:payload.summary,headlines:payload.headlines,sections:payload.sections,methodology:payload.methodology,filters:payload.filters,reportTiming:payload.reportTiming}}];
   if(!context.sources.some(x=>x.id===sourceId))context.sources.push({id:sourceId,label:`${c.client.name} · ${saved.storeDate} · revision ${saved.revision}`,url:`/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(saved.id)}`});
   const scopeKey=await fingerprint({clientIds:[clientId],filters:context.filters,reviewId});return {scope,s,context,scopeKey};
  }
 }
 const records=await Promise.all(clients.map(async client=>{
  const selection=fastChat?chatObservationSelection(filters.view,question):undefined,preparedDatasets=selection?.datasets;
  const monthHistory=!fastChat||chatNeedsMonthHistory(question),reviewIndexOnly=fastChat&&!reviewId&&!chatNeedsReviewBody(question);
  const [rows,closedRows,connections,note,findings,allReviews]=await Promise.all([
   s.observations(scope.organizationId,client.id,filters,false,undefined,selection??(sourceOnly?{datasets:[...reviewHistoryDatasets,...reviewDetailDatasets],includePriorWeek:false}:undefined)),
   fastChat?Promise.resolve([]):sourceOnly?Promise.all([
    s.observations(scope.organizationId,client.id,{...filters,from:[filters.to.slice(0,8)+'01',shiftDate(filters.to,-7)].sort()[0],mode:'closed',compare:'weekday'},false,undefined,{datasets:reviewHistoryDatasets,includePriorWeek:false}),
    s.observations(scope.organizationId,client.id,{...filters,from:filters.mode==='partial'?shiftDate(filters.to,-1):filters.to,to:filters.mode==='partial'?shiftDate(filters.to,-1):filters.to,mode:'closed',compare:'previous',compareFrom:undefined,compareTo:undefined},false,undefined,{datasets:reviewDetailDatasets,includePriorWeek:false})
   ]).then(parts=>parts.flat()):s.observations(scope.organizationId,client.id,{...filters,from:[filters.to.slice(0,8)+'01',shiftDate(filters.to,-7)].sort()[0],mode:'closed',compare:'weekday'}),
   s.connections(scope.organizationId,client.id),s.note(scope.organizationId,client.id),s.findings(scope.organizationId,client.id),s.reviews(scope.organizationId,client.id,reviewIndexOnly)
  ]);
  if(reviewId&&!allReviews.some(r=>r.id===reviewId)){const r=await s.first('SELECT * FROM reviews WHERE organizationId=? AND clientId=? AND id=?',scope.organizationId,client.id,reviewId);if(!r)throw new Error('Review access denied');allReviews.unshift({...r,payload:JSON.parse(r.payload),current:!!r.current});}
  const priorMonthStart=Temporal.PlainDate.from(filters.to).subtract({months:1}).toString().slice(0,8)+'01';
  const headlineRows=monthHistory?await s.observations(scope.organizationId,client.id,{...filters,from:priorMonthStart,view:'overview'},true):[],monthRows=headlineRows.filter(r=>r.dataset==='overview');
  const referenceRows=rows.filter(row=>row.dataset==='overview');
  const weekday=queryClient(client,referenceRows,connections,{...filters,view:'overview',compare:'weekday'},{preparedDatasets:['overview']}),previousDay=queryClient(client,referenceRows,connections,{...filters,view:'overview',compare:'previous'},{preparedDatasets:['overview']});
  const mtFrom=filters.to.slice(0,8)+'01',priorDate=Temporal.PlainDate.from(filters.to).subtract({months:1}).toString(),priorFrom=priorDate.slice(0,8)+'01';
  const selected=queryClient(client,rows,connections,filters,fastChat?{preparedDatasets}:undefined);
  const mt=monthHistory?monthToDateSummary(client,monthRows,{...filters,from:mtFrom},selected.cutoff):null,priorMt=monthHistory?monthToDateSummary(client,monthRows,{...filters,from:priorFrom,to:priorDate},selected.cutoff):null;
  if(fastChat)selected.warnings.push(`This chat checked numeric detail for ${chatDatasets(filters.view,question).join(', ')}. Other datasets were not loaded for this question.`);
  if(fastChat&&!selection?.trendDatasets.length)selected.warnings.push('Historical chart detail was not requested for this question; unexamined dates must not be treated as source gaps.');
  if(reviewIndexOnly)selected.warnings.push('Saved reviews are supplied as indexed summaries; full report bodies were not loaded for this live question.');
  return {...selected,note,findings,reviews:allReviews,
   weekday:{metrics:weekday.prior,period:weekday.comparison,warnings:weekday.warnings},previousDay:{metrics:previousDay.prior,period:previousDay.comparison,warnings:previousDay.warnings},
   supplemental:supplementalReviewEvidence(client,fastChat?rows:closedRows,connections,filters),
   monthToDate:{current:mt,previous:priorMt,instruction:monthHistory?'Use fullElapsedDayCoverage and per-metric coverage, not merely observed dates, before claiming complete MTD. Earlier store days are closed; only the final date uses the shared local partial-day clock. Without a confirmed cutoff or complete revenue/order coverage, label observed totals and report missing or unconfirmed dates.':'MTD history was not loaded for this selected-period question. Its values are unknown, never zero.'}
  };
 }));
 if(sourceOnly)for(const record of records){record.findings=record.findings.map(f=>{const copy={...f} as typeof f&{latestCheck?:unknown};delete copy.latestCheck;return copy;});record.reviews=record.reviews.filter(r=>r.payload.type==='historical').map(r=>({...r,current:!record.reviews.some(x=>x.payload.type==='historical'&&x.storeDate===r.storeDate&&x.revision>r.revision)}));}
 const context=buildAIContext(records,filters,reviewId),scopeKey=await fingerprint({clientIds:clients.map(c=>c.id).sort(),filters,reviewId:reviewId??null});return {scope,s,context,scopeKey};
}
export function parseAIRequest(b:any){const params=new URLSearchParams();for(const key of ['from','to','mode','compare','compareFrom','compareTo','view','market','source','stream','device','page'])if(typeof b.filters?.[key]==='string')params.set(key,b.filters[key]);if([...params.values()].some(v=>v.length>500))throw new Error('Filter too long');return {filters:parseFilters(params),clientId:typeof b.clientId==='string'&&b.clientId?b.clientId:undefined,reviewId:typeof b.reviewId==='string'&&b.reviewId?b.reviewId:undefined};}
export async function reserveAI(s:Store,scope:AccessScope){const hour=new Date(Date.now()-3600000).toISOString(),count=await s.first('SELECT COUNT(*) AS n FROM ai_requests WHERE organizationId=? AND actorId=? AND createdAt>?',scope.organizationId,scope.actorId,hour);if(count.n>=60)throw new Error('Hourly AI request limit reached. Please try again later.');await s.run('INSERT INTO ai_requests(id,organizationId,actorId,createdAt) VALUES(?,?,?,?)',crypto.randomUUID(),scope.organizationId,scope.actorId,new Date().toISOString());}
export async function aiHistory(s:Store,scope:AccessScope,scopeKey:string){return (await s.all('SELECT * FROM ai_turns WHERE organizationId=? AND actorId=? AND scopeKey=? ORDER BY createdAt DESC LIMIT 20',scope.organizationId,scope.actorId,scopeKey)).reverse().map(r=>({...r,payload:JSON.parse(r.payload)}));}
export async function generateAIReview(scope:AccessScope,clientId:string,filters:QueryFilters,job?:ScheduledReviewLease){const {period:_livePeriod,...fixedFilters}=filters;filters=fixedFilters;const {s,context}=await aiContext(clientId,filters,undefined,scope,true);const c=context.clients[0];if(!c||!c.selectedObservationCount&&!c.sourceReviews.length&&!Object.values(c.priorClosedDetail?.datasets??{}).some(d=>d.rows.length)&&!c.closedPriorDay?.current.evidenceCount)throw new Error('No source evidence is available for this review');
 // Exclude generated AI copies so an unchanged evidence bundle remains idempotent.
 for(const c of context.clients){const live=c.sourceQuality.some(q=>q!=='historical')||c.closedPriorDay?.current.sourceQuality.some(q=>q!=='historical');c.sourceReviews=live?[]:c.sourceReviews.filter(r=>(r.payload as any).type==='historical');c.priorSourceReviews=live?[]:c.priorSourceReviews.filter(r=>(r.payload as any).type==='historical');}
 context.sources=context.sources.filter(s=>!s.id.startsWith('review:')||context.clients.some(c=>[...c.sourceReviews,...c.priorSourceReviews].some(r=>r.sourceId===s.id)));
 const reviewStandardVersion='avenuez-daily-v3',inputFingerprint=await fingerprint({reviewStandardVersion,context}),current=await s.first('SELECT * FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND current=1',scope.organizationId,clientId,filters.to);if(current&&JSON.parse(current.payload).inputFingerprint===inputFingerprint){if(job)await s.saveReview(scope.organizationId,clientId,filters.to,current.fingerprint,JSON.parse(current.payload),new Date().toISOString(),job);return current.id;}
 const key=serverSecret('OPENAI_API_KEY');if(!key)throw new Error('OpenAI is not configured');await reserveAI(s,scope);
 const analysisContext={...context,clients:context.clients.map(client=>({...client,qualifiedPageOpportunities:rankedReviewPages(client,filters).map(page=>({...page,sourceId:client.sourceId,selectedDate:filters.to,comparisonDate:client.comparison.to,qualification:'Exact supplied same-page or configured-market comparison passing the traffic, source coverage and opportunity thresholds. Gap estimates are converting sessions, not measured lost orders; diagnose page/offer/traffic hypotheses before acting.'}))}))};
 const parsed=reviewSchema.safeParse(await askOpenAI(key,serverSecret('OPENAI_MODEL')||'gpt-5.4-mini',JSON.stringify(boundedAIContextForModel(analysisContext)),[],`Write the complete daily review for ${filters.to}. Include each required section exactly once, in this order: ${REVIEW_SECTIONS.join('; ')}. Return 2–3 short paragraphs in summary for The read in 30 seconds: traffic vs conversion, spend vs revenue and the biggest supported opportunity. Also return 4–6 headlines, including spend vs revenue. Return an empty tables array in every section: the application attaches all available numeric detail tables directly from the supplied evidence after this analysis. Do not duplicate table cells in prose. Explain the significant supplied landing-page, renewal, channel-spend and closed-day MER findings with their exact date scopes. Keep current partial and closed-day references explicitly separate. A required unavailable cut must be stated in Sources & limitations. State unavailable checks in Sources & limitations; do not claim the review is comprehensive when required providers or comparisons are missing. Treat original finding details as dated workflow history, never current measurements. A current page/source conclusion requires matching dated numeric evidence; unavailable traffic-source cuts must stay unavailable. Follow the supplied spendVerdict exactly: when it is unavailable, ratios are arithmetic only and no efficiency or profitability conclusion is established. Never call any MER value break-even without margin evidence. Keep historical source conclusions dated. Also return at most ${c.client.config.maxActions} structured business actions for the admin's queue; each must have a concrete nextStep, dated sourceIds, and an impact only when the supplied evidence supports it. For every action check all supplied findings by issue and next step, not just title wording. If it concerns an existing issue, set existingFindingId to that finding's exact supplied id, including closed findings; these will remain in the existing workflow rather than create a duplicate task. Set existingFindingId to null only for a distinct new issue. Existing issues may receive one dated evidence recheck with existingFindingId preserved. Keep the original issue identity and workflow; do not represent an existing or closed finding as a new action. A higher-converting homepage or different page is not a conversion benchmark for a landing page. Only use its own matched previous period, the same page in the configured benchmark market, or a justified comparable-family benchmark. Do not create new actions from unspecified strongest-page comparisons. No connectivity or availability actions. Every action must include an exact dated numeric observation and its supported comparison from the supplied model evidence, with a practical next step for the team. Prefer qualifiedPageOpportunities when supplied, preserving their exact page, market, benchmark and estimated converting-session gap. A historical issue without matching dated numeric support belongs on the watch list, not in the action queue. A numeric collection omitted from this bounded preview remains supplied in the saved report appendix; do not describe preview omission as unavailable source data or create an action just to request those omitted rows.`,fetch,'review'));
 if(!parsed.success)throw new Error('The AI review did not meet the required report format. Please retry.');
 const result=parsed.data;
 const spend=authoritativeSpendReview(c.metrics,c.prior,c.client.currency,c.spendVerdict.spendComparison!=='unavailable');
 const spendIndex=result.headlines.findIndex(h=>/spend.*revenue|revenue.*spend/i.test(h));result.headlines[spendIndex<0?0:spendIndex]=spend.headline;
 if(result.summary)result.summary[1]=spend.paragraph;
 const spendSection=result.sections.find(s=>s.title==='Spend vs revenue');
 if(spendSection){spendSection.paragraphs=[spend.paragraph];spendSection.bullets=[];spendSection.tables=[{title:'Spend vs revenue',scope:`${filters.from}–${filters.to} vs ${c.comparison.from}–${c.comparison.to} · ${filters.mode} · ${c.client.timezone}${c.cutoff?` · cutoff ${c.cutoff}`:''}`,columns:spend.columns,rows:spend.rows,sourceIds:[c.sourceId]}];delete spendSection.table;}
 // Numeric appendix cells are rendered from the authorized evidence. Model
 // prose explains the findings; it cannot replace these source-backed figures.
 const detailSection=result.sections.find(s=>s.title==='Detail tables');
 if(detailSection){detailSection.tables=evidenceReviewTables(c,filters).slice(0,30);delete detailSection.table;}
 const refined=refineReview(result,c,filters);
 if(REVIEW_SECTIONS.some(title=>result.sections.filter(s=>s.title===title).length!==1)||result.sections.length!==REVIEW_SECTIONS.length)throw new Error('AI review omitted a required section; retry');
 result.sections.sort((a,b)=>REVIEW_SECTIONS.indexOf(a.title)-REVIEW_SECTIONS.indexOf(b.title));
 if([...result.sourceIds,...result.actions.flatMap(a=>a.sourceIds),...(refined.watchActions??[]).flatMap(a=>a.sourceIds),...result.sections.flatMap(section=>(section.tables??[]).flatMap(t=>t.sourceIds))].some(id=>!context.sources.some(s=>s.id===id)))throw new Error('AI returned an unsupported citation; retry');if(result.actions.length>c.client.config.maxActions)throw new Error('AI exceeded the configured action limit; retry');
 if([...result.actions,...refined.watchActions??[]].some(a=>a.existingFindingId!==null&&!c.findings.some(f=>f.id===a.existingFindingId)))throw new Error('AI returned an unsupported follow-up reference; retry');
 const payload={type:'ai',title:`${c.client.name} daily review`,methodology:'avenuez-strategy · OpenAI evidence analysis',reviewStandardVersion,inputFingerprint,filters,generatedAt:new Date().toISOString(),model:serverSecret('OPENAI_MODEL')||'gpt-5.4-mini',...result,reportTiming:c.reportTiming,sources:context.sources,evidence:compactAIContextForModel(context),...(job?{scheduleJobId:job.id}:{})};const id=await s.saveReview(scope.organizationId,clientId,filters.to,await fingerprint(payload),payload,new Date().toISOString(),job);await s.audit(scope.organizationId,clientId,scope.actorId,'review.ai.generated',{id,inputFingerprint});return id;
}
export async function answerAI(b:any,existingScope?:AccessScope){if(typeof b.question!=='string'||!b.question.trim()||b.question.length>3000)throw new Error('Ask a question of up to 3,000 characters');const a=parseAIRequest(b),{scope,s,context,scopeKey}=await aiContext(a.clientId,a.filters,a.reviewId,existingScope,false,true,b.question);
 const key=serverSecret('OPENAI_API_KEY');if(!key)throw new Error('OpenAI is not configured');await reserveAI(s,scope);const history=await aiHistory(s,scope,scopeKey);
 const answer=validateAnswer(await askOpenAI(key,serverSecret('OPENAI_MODEL')||'gpt-5.4-mini',JSON.stringify(buildChatModelContext(context,b.question)),history.slice(-4).map(r=>({question:r.question,answer:r.payload.answer.slice(0,4000)})),b.question),context.sources);
 const payload={...answer,sources:context.sources.filter(s=>answer.sourceIds.includes(s.id)),scope:{filters:context.filters,clients:context.clients.map(c=>c.client.name),reviewId:b.reviewId??null},evidenceFingerprint:await fingerprint(context)},id=crypto.randomUUID(),createdAt=new Date().toISOString();await s.run('INSERT INTO ai_turns(id,organizationId,actorId,scopeKey,question,payload,createdAt) VALUES(?,?,?,?,?,?,?)',id,scope.organizationId,scope.actorId,scopeKey,b.question,JSON.stringify(payload),createdAt);return {id,question:b.question,payload,createdAt};
}
