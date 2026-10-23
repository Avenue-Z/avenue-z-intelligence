import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {vi,it,expect,beforeEach} from 'vitest';
import {Store} from '../../lib/server/store';
import {authorize} from '../../lib/server/policy';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as any,scope:{organizationId:'o',actorId:'u',role:'analyst',permittedClientIds:['beam']},model:vi.fn(),ga4Config:null as string|null}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store,requireClientAccess:async(id?:string)=>authorize(state.scope as any,id)}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='OPENAI_API_KEY'?'test-only':name==='SOURCE_BEAM_GA4'?state.ga4Config:null}));
vi.mock('../../lib/ai/provider',()=>({askOpenAI:state.model}));
import {aiContext,aiHistory,answerAI,generateAIReview,parseAIRequest} from '../../lib/ai/server';
import {REVIEW_SECTIONS,compactAIContextForModel} from '../../lib/ai/context';
import {fingerprint} from '../../lib/reviews/build';
import type {Observation,Connection} from '../../lib/analytics/contracts';
import {saveGa4DayReports,type Ga4CachedReport} from '../../lib/server/ga4-report-cache';
import {evidenceReviewTables} from '../../lib/reviews/tables';
import {queryClient} from '../../lib/analytics/query';
import {buildAlertQueue} from '../../lib/analytics/alerts';
const filters={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview',market:'',source:'',page:'',device:'',stream:''} as const;
function database(){const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))db.exec(readFileSync(`drizzle/${f}`,'utf8'));return {prepare(sql:string){let values:any[]=[];const p={bind(...v:any[]){values=v;return p;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return p;},async batch(statements:any[]){db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};}
beforeEach(async()=>{state.ga4Config=null;state.store=new Store(database());state.model.mockReset();for(const c of clients)await state.store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',c.id,'o',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);});
it('rejects a forbidden client and an unrelated review before any model request',async()=>{await expect(answerAI({clientId:'kind-patches',filters,question:'Give me their revenue'})).rejects.toThrow('access');await expect(aiContext('beam',filters,'kind-only-review')).rejects.toThrow('access');expect(state.model).not.toHaveBeenCalled();});
it('answers a saved AI review from its original evidence even after live snapshots change',async()=>{
 const batch={clientId:'beam',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows:[{date:filters.to,dataset:'overview',metric:'revenue',value:100,definition:'net_sales',population:'sales',currency:'USD',dimensions:{}}]} as any;
 await state.store.persistBatch('o','qualified',batch,'original','2026-10-08T10:00:00Z');const original=(await aiContext('beam',filters)).context;
 const id=await state.store.saveReview('o','beam',filters.to,'fixed',{type:'ai',filters,evidence:compactAIContextForModel(original),headlines:['Revenue was $100']},'2026-10-08T10:01:00Z');
 await state.store.persistBatch('o','qualified',{...batch,rows:batch.rows.map((r:any)=>({...r,value:999}))},'changed','2026-10-08T11:00:00Z');
 const fixed=await aiContext('beam',{...filters,to:'2026-10-08'},id);expect(fixed.context.clients[0].metrics.revenue).toBe(100);expect(fixed.context.filters.to).toBe(filters.to);expect(fixed.context.clients[0].selectedReview?.revision).toBe(1);expect(fixed.context.sources.some(s=>s.id===`review:${id}`)).toBe(true);
});
it('recomputes server context, ignores a forged scope key, and isolates persisted history by actor',async()=>{state.model.mockResolvedValue({answer:'No evidence in this window',sourceIds:['selection:beam'],followUps:[],caveats:['Historical only']});await answerAI({clientId:'beam',filters,scopeKey:'forged',question:'What is shown?'});const a=await aiContext('beam',filters);expect(await aiHistory(a.s,a.scope,a.scopeKey)).toHaveLength(1);expect(await aiHistory(a.s,{...a.scope,actorId:'other'},a.scopeKey)).toEqual([]);expect(await aiHistory(a.s,{...a.scope,organizationId:'other'},a.scopeKey)).toEqual([]);expect(await aiHistory(a.s,a.scope,'forged')).toEqual([]);expect(state.model.mock.calls[0][2]).toContain('2026-10-07');});
it('persists the chat analysis standard and forwards assistant history only for the exact unchanged evidence',async()=>{
 const question='What needs our attention, and why?';state.model.mockResolvedValue({answer:'Compatible analysis from the current evidence',sourceIds:['selection:beam'],followUps:[],caveats:[]});
 const first=await answerAI({clientId:'beam',filters,question});expect(first.payload).toMatchObject({analysisStandardVersion:'avenuez-chat-v1',evidenceFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
 const second=await answerAI({clientId:'beam',filters,question});expect(second.payload.evidenceFingerprint).toBe(first.payload.evidenceFingerprint);expect(state.model.mock.calls[1][3]).toEqual([{question,answer:first.payload.answer}]);
});
it('retains prior user questions and visible legacy answers while excluding legacy, wrong-version and wrong-evidence assistant text from model input',async()=>{
 const question='What needs our attention, and why?',frame=await aiContext('beam',filters,undefined,undefined,false,true,question),evidenceFingerprint=await fingerprint(frame.context),prior=[{question:'Legacy question',payload:{answer:'Legacy flawed assistant'}},{question:'Earlier standard question',payload:{answer:'Wrong version assistant',analysisStandardVersion:'avenuez-chat-v0',evidenceFingerprint}},{question:'Changed evidence question',payload:{answer:'Different evidence assistant',analysisStandardVersion:'avenuez-chat-v1',evidenceFingerprint:'different-evidence'}}];
 for(const [index,turn] of prior.entries())await (state.store as Store).run('INSERT INTO ai_turns VALUES(?,?,?,?,?,?,?)',`prior-${index}`,'o','u',frame.scopeKey,turn.question,JSON.stringify(turn.payload),`2026-10-08T00:00:0${index}Z`);
 state.model.mockResolvedValue({answer:'Current source analysis',sourceIds:['selection:beam'],followUps:[],caveats:[]});await answerAI({clientId:'beam',filters,question});
 expect(state.model.mock.calls[0][3]).toEqual(prior.map(turn=>({question:turn.question})));expect(JSON.stringify(state.model.mock.calls[0][3])).not.toMatch(/Legacy flawed|Wrong version|Different evidence/);
 const displayed=await aiHistory(state.store,frame.scope,frame.scopeKey);for(const turn of prior)expect(displayed.find(row=>row.question===turn.question)?.payload.answer).toBe(turn.payload.answer);
});
it('drops a formerly compatible assistant answer after actual source observations change',async()=>{
 const question='What needs our attention, and why?';state.model.mockResolvedValue({answer:'First source analysis',sourceIds:['selection:beam'],followUps:[],caveats:[]});const first=await answerAI({clientId:'beam',filters,question});
 const rows:Observation[]=[{date:filters.to,dataset:'overview',metric:'revenue',value:100,definition:'beam_shopify_net_sales_all_channels_excluding_faire',population:'beam_shopify_sales_excluding_faire',currency:'USD',dimensions:{},sourceId:'qualified',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T04:00:00Z',quality:'complete'}];
 await (state.store as Store).persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows},'new-chat-source-evidence','2026-10-08T10:00:00Z');
 const second=await answerAI({clientId:'beam',filters,question});expect(second.payload.evidenceFingerprint).not.toBe(first.payload.evidenceFingerprint);expect(state.model.mock.calls[1][3]).toEqual([{question}]);expect(state.model.mock.calls[1][2]).toContain('100');
});
it('keeps the existing four-turn model history bound even when all legacy assistant messages are omitted',async()=>{
 const question='What needs our attention, and why?',frame=await aiContext('beam',filters,undefined,undefined,false,true,question);
 for(let index=0;index<6;index++)await (state.store as Store).run('INSERT INTO ai_turns VALUES(?,?,?,?,?,?,?)',`bounded-${index}`,'o','u',frame.scopeKey,`Prior question ${index}`,JSON.stringify({answer:`Legacy answer ${index}`}),`2026-10-08T00:00:0${index}Z`);
 state.model.mockResolvedValue({answer:'Current source analysis',sourceIds:['selection:beam'],followUps:[],caveats:[]});await answerAI({clientId:'beam',filters,question});expect(state.model.mock.calls[0][3]).toEqual([2,3,4,5].map(index=>({question:`Prior question ${index}`})));
});
it('preserves the source report and deduplicates AI reruns against unchanged original evidence',async()=>{await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated review'},'2026-10-08T00:00:00Z');state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Unavailable'],bullets:[],table:{columns:[],rows:[]}})),sourceIds:[],actions:[]});await generateAIReview(state.scope as any,'beam',filters);await generateAIReview(state.scope as any,'beam',filters);expect(state.model).toHaveBeenCalledTimes(1);const r=await state.store.reviews('o','beam');expect(r).toHaveLength(2);expect(r.find((x:any)=>x.revision===1).payload.text).toBe('Original dated review');});
it('preserves a dated AI recheck and renders its next step even if the model left the action section empty',async()=>{await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated review'},'2026-10-08T00:00:00Z');await state.store.saveFinding('o','beam',{id:'existing',title:'Review landing page traffic mix',detail:'Check paid traffic',severity:'investigate',owner:'Team',status:'open',evidence:[]},'u',0);state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Unavailable'],bullets:[],table:{columns:[],rows:[]}})),sourceIds:[],actions:[{existingFindingId:'existing',title:'Investigate traffic dilution on the PDP',detail:'Same issue under different wording',nextStep:'Check paid traffic',severity:'investigate',impact:null,sourceIds:['selection:beam']}]});await generateAIReview(state.scope as any,'beam',filters);const payload=(await state.store.reviews('o','beam'))[0].payload as any;expect(payload.actions).toEqual([]);expect(payload.watchActions).toMatchObject([{existingFindingId:'existing',nextStep:'Check paid traffic',sourceIds:['selection:beam']}]);expect(payload.sections.find((s:any)=>s.title==='Watch list').bullets.join(' ')).toContain('Check paid traffic');expect(state.model.mock.calls[0][2]).toContain('existing');});
it('persists a measured dopamine recommendation separately without replacing the MB Trio workflow check',async()=>{
 const client=clients.find(client=>client.id==='kind-patches')!,scope={...state.scope,permittedClientIds:['kind-patches']},detail='Historical US MB Trio scaling and UK offer comparison.';
 await state.store.saveFinding('o','kind-patches',{id:'mb-trio',title:'US MB Trio: review scaling and offer alignment',detail,severity:'investigate',status:'open',owner:'Team',evidence:[]},'u',0);
 const rows=['2026-10-06','2026-10-07'].flatMap(date=>[{date,dataset:'overview',metric:'revenue',value:100,definition:'web_nonrecurring_excl_tax_shipping',population:'web_nonrecurring',currency:'USD',dimensions:{}},...['sessions','converting_sessions'].map(metric=>({date,dataset:'funnels',metric,value:metric==='sessions'?2000:date===filters.to?40:80,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/pages/dopamine',market:'US'}}))]) as any;
 await state.store.persistBatch('o','source',{clientId:client.id,timezone:client.timezone,currency:client.currency,grain:'daily',channels:[],dimensions:['page','market'],complete:true,coverageThrough:'2026-10-08T00:00:00Z',rows},'page-link-regression','2026-10-08T01:00:00Z');
 const action={existingFindingId:'mb-trio',title:'Review US /pages/dopamine weakness',detail:'On 2026-10-07, /pages/dopamine had 2,000 sessions at CVR 2% versus 4% in its own prior period.',nextStep:'Inspect the same page offer and traffic mix.',severity:'investigate',impact:40,sourceIds:['selection:kind-patches']};
 state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['A','B','C','D'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]})),sourceIds:[],actions:[action]});
 await generateAIReview(scope as any,client.id,filters);
 const reviews=await state.store.reviews('o',client.id),findings=await state.store.findings('o',client.id);
 expect(reviews[0].payload.actions).toEqual([{...action,existingFindingId:null}]);expect(findings[0]).toMatchObject({id:'mb-trio',detail,status:'open',owner:'Team'});expect(findings[0].latestCheck).toBeUndefined();
 const observed=await state.store.observations('o',client.id,filters),record={...queryClient(client as any,observed,[],filters),reviews,findings} as any;
 const queue=buildAlertQueue([record],filters),conversion=queue.filter(alert=>alert.category==='Conversion opportunity');
 expect(conversion).toHaveLength(1);expect(conversion[0].evidence).toContain('/clients/kind-patches/reviews/'+encodeURIComponent(reviews[0].id));expect(queue.find(alert=>alert.title===action.title)).toBeUndefined();
 expect(buildAlertQueue([record],filters).find(alert=>alert.key==='mb-trio')).toMatchObject({detail});
});
it('saves numeric detail tables from authorized observations instead of model-retyped figures',async()=>{
 const batch={clientId:'beam',timezone:'America/New_York',currency:'USD',channels:[],dimensions:['market'],grain:'daily',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows:[{date:filters.to,dataset:'markets',metric:'revenue',value:100,population:'sales',definition:'net_sales',currency:'USD',dimensions:{market:'US'}},{date:filters.to,dataset:'markets',metric:'orders',value:5,population:'sales',definition:'net_sales',currency:null,dimensions:{market:'US'}}]};
 await state.store.persistBatch('o','qualified',batch as any,'data','2026-10-08T10:00:00Z');state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Sales supplied','Spend vs revenue unavailable','Market detail available','Source-backed figures'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:title==='Detail tables'?[{title:'Incorrect retyped sales',scope:'today',columns:['Sales'],rows:[['$99,999']],sourceIds:['selection:beam']}]:[]})),sourceIds:[],actions:[]});
 await generateAIReview(state.scope as any,'beam',filters);const p=(await state.store.reviews('o','beam'))[0].payload as any,detail=p.sections.find((s:any)=>s.title==='Detail tables');expect(JSON.stringify(detail.tables)).toContain('$100.00');expect(JSON.stringify(detail.tables)).toContain('$20.00');expect(JSON.stringify(detail.tables)).not.toContain('$99,999');
});
it('uses current evidence without feeding old report measurements back as current analysis',async()=>{
 await state.store.saveReview('o','beam','2026-10-06','old',{type:'historical',text:'Old campaign checkout completion was 38.23 percent'},'2026-10-07T10:00:00Z');
 await state.store.persistBatch('o','qualified',{clientId:'beam',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows:[{date:filters.to,dataset:'overview',metric:'revenue',value:100,definition:'net_sales',population:'sales',currency:'USD',dimensions:{}}]} as any,'live','2026-10-08T10:00:00Z');
 state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Spend vs revenue is efficient','Current evidence','Page check','Source check'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['MER proves profit'],bullets:[],tables:[]})),sourceIds:[],actions:[]});
 await generateAIReview(state.scope as any,'beam',filters);expect(state.model.mock.calls[0][2]).not.toContain('38.23');const p=(await state.store.reviews('o','beam'))[0].payload as any;expect(p.headlines[0]).toContain('coverage is unconfirmed');expect(p.sections.find((s:any)=>s.title==='Spend vs revenue').paragraphs[0]).toContain('does not establish');
});

it('answers an ordinary live question from one selected/comparison read without a month export',async()=>{
 state.model.mockResolvedValue({answer:'No evidence in this window',sourceIds:['selection:beam'],followUps:[],caveats:[]});
 const spy=vi.spyOn(state.store,'observations');await answerAI({clientId:'beam',filters,question:'What is shown?'});
 expect(spy.mock.calls.filter(call=>call[3]!==true)).toHaveLength(1);expect(spy.mock.calls.filter(call=>call[3]===true)).toHaveLength(0);
});
it('loads exact landing-page market comparisons without dense historical trend cohorts',async()=>{
 const scoped={...filters,mode:'partial' as const,view:'traffic',page:'/pages/glplpv4'},source='qualified';
 const rows:Observation[]=['2026-10-01','2026-10-06','2026-10-07'].flatMap(date=>['US','CA'].flatMap(market=>['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts'].map(metric=>({date,dataset:'traffic',metric,value:metric==='sessions'?100:metric==='checkouts'?date===filters.to?10:20:metric==='completed_checkouts'||metric==='converting_sessions'?date===filters.to?3:10:30,definition:'human_public_landing_traffic',population:'human_public_landing_sessions',currency:null,dimensions:{page:scoped.page,market,source:'social',utm_source:'facebook'},start:`${date}T12:00:00Z`,end:`${date}T13:00:00Z`,sourceId:source,retrievedAt:'2026-10-07T13:10:00Z',coverageThrough:'2026-10-07T13:00:00Z',quality:'complete'}))));
 await state.store.persistBatch('o',source,{clientId:'beam',timezone:'America/New_York',currency:'USD',channels:[],dimensions:['page','market','source','utm_source'],grain:'hourly',complete:true,coverageThrough:'2026-10-07T13:00:00Z',rows},'chat-selected-period','2026-10-07T13:10:00Z');
 vi.spyOn(state.store,'connections').mockResolvedValue([{id:source,provider:'kind-shopify-traffic',enabled:true,coverageThrough:'2026-10-07T13:00:00Z'}] as Connection[]);
 const reads=vi.spyOn(state.store,'observations'),result=await aiContext('beam',scoped,undefined,undefined,false,true,'Which market has the weakest checkout completion for this landing page today, compared with the same time yesterday?');
 expect(reads.mock.calls).toHaveLength(1);expect(reads.mock.calls[0][5]).toMatchObject({dimensions:true,includePriorWeek:false,trendDatasets:[]});
 const loaded=await reads.mock.results[0].value as Observation[];expect([...new Set(loaded.filter(row=>row.dataset==='traffic').map(row=>row.date))].sort()).toEqual(['2026-10-06','2026-10-07']);
 const traffic=result.context.clients[0].visualBreakdowns.traffic,current=traffic.current!.cuts.market.rows.find(row=>row.dimensions.market==='CA')!,previous=traffic.comparison!.cuts.market.rows.find(row=>row.dimensions.market==='CA')!;
 expect(current.metrics).toMatchObject({checkouts:10,completed_checkouts:3});expect(current.summary.checkoutCompletion).toBe(.3);expect(previous.metrics).toMatchObject({checkouts:20,completed_checkouts:10});expect(previous.summary.checkoutCompletion).toBe(.5);
 expect(traffic.current!.scope.cutoff).toBe('2026-10-07T13:00:00Z');expect(traffic.comparison!.scope.cutoff).toBe('2026-10-06T13:00:00Z');
 expect(result.context.clients[0].monthToDate).toMatchObject({current:null,previous:null});
});
it('loads month headline history only when the live question asks for it',async()=>{
 const rows:Observation[]=[['2026-09-07',20],['2026-10-01',30],['2026-10-07',100]].map(([date,value])=>({date:String(date),dataset:'overview',metric:'revenue',value:Number(value),definition:'net_sales',population:'sales',currency:'USD',dimensions:{},sourceId:'qualified',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T04:00:00Z',quality:'complete'}));
 await state.store.persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows},'chat-month-evidence','2026-10-08T10:00:00Z');
 const reads=vi.spyOn(state.store,'observations'),result=await aiContext('beam',filters,undefined,undefined,false,true,'Compare month-to-date revenue with last month.');
 expect(reads.mock.calls.filter(call=>call[3]===true)).toHaveLength(1);
 expect(result.context.clients[0].monthToDate).toMatchObject({current:{metrics:{revenue:130},fullElapsedDayCoverage:false},previous:{metrics:{revenue:20},fullElapsedDayCoverage:false}});
});
it('uses saved review summaries for an ordinary live question and full bodies only when requested',async()=>{
 const text='Original full dated review body '.repeat(1000),id=await state.store.saveReview('o','beam',filters.to,'dated',{type:'historical',text,kpis:[{label:'Revenue',value:'$100',note:'Dated source claim'}]},'2026-10-08T10:00:00Z'),reads=vi.spyOn(state.store,'reviews');
 const live=await aiContext('beam',filters,undefined,undefined,false,true,'What needs our attention?');expect(reads.mock.calls[0][2]).toBe(true);expect(live.context.clients[0].sourceReviews[0].payload.text).toBeUndefined();expect(live.context.clients[0].sourceReviews[0].payload.kpis).toHaveLength(1);
 const requested=await aiContext('beam',filters,undefined,undefined,false,true,'Explain this daily review.');expect(reads.mock.calls[1][2]).toBe(false);expect(requested.context.clients[0].sourceReviews[0].payload.text).toBe(text);
 expect((await state.store.reviews('o','beam')).find((review:{id:string})=>review.id===id).payload.text).toBe(text);
});
it('answers the default seven-day chart from loaded daily history and the latest selected values',async()=>{
 const dates=['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'];
 const rows=dates.flatMap((date,index)=>[{date,dataset:'products',metric:'revenue',value:index===7?200:100+index*10,definition:'net_sales',population:'product_sales',currency:'USD',dimensions:{product:'Daily product'}},{date,dataset:'products',metric:'orders',value:10,definition:'product_orders',population:'product_sales',currency:null,dimensions:{product:'Daily product'}}]);
 await state.store.persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',channels:[],dimensions:['product'],grain:'daily',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows:rows.map(row=>({...row,sourceId:'qualified',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T04:00:00Z',quality:'complete' as const}))},'chart-history','2026-10-08T10:00:00Z');
 state.model.mockResolvedValue({answer:'The seven-day sales trend ends at $200.',sourceIds:['selection:beam'],followUps:[],caveats:[]});
 const reads=vi.spyOn(state.store,'observations');await answerAI({clientId:'beam',filters:{...filters,view:'products'},question:'Explain the default seven-day Product performance over time chart.'});
 const input=JSON.parse(state.model.mock.calls[0][2]),view=input.context.clients[0].selectedView;
 expect(view.current.summary.revenue).toBe(200);expect(view.dailyChart.defaultRange).toMatchObject({from:'2026-10-01',to:'2026-10-07',comparisonFrom:'2026-09-30',comparisonTo:'2026-10-06'});
 expect(view.dailyChart.current.filter((day:{date:string})=>day.date>='2026-10-01').map((day:{metrics:Record<string,number|null>})=>day.metrics.revenue)).toEqual([110,120,130,140,150,160,200]);
 expect(view.dailyChart.comparison.filter((day:{date:string})=>day.date>='2026-09-30').map((day:{metrics:Record<string,number|null>})=>day.metrics.revenue)).toEqual([100,110,120,130,140,150,160]);
 expect(view.dailyChart.scope.sourceId).toBe('selection:beam');expect(Buffer.byteLength(state.model.mock.calls[0][2])).toBeLessThanOrEqual(80000);
 expect(reads.mock.calls.find(call=>call[3]!==true)?.[5]).toMatchObject({trendDatasets:expect.arrayContaining(['products'])});
 expect(reads.mock.calls.filter(call=>call[3]===true)).toHaveLength(0);
});
it('builds weekday and previous-day headline references without preparing dense Traffic tables',async()=>{
 const query=await import('../../lib/analytics/query'),spy=vi.spyOn(query,'queryClient');
 try{
 const rows=['2026-10-07','2026-10-06','2026-09-30'].flatMap((date,index)=>[{date,dataset:'overview',metric:'revenue',value:[300,200,100][index],definition:'net_sales',population:'sales',currency:'USD',dimensions:{},quality:'complete'},{date,dataset:'traffic',metric:'sessions',value:999,definition:'sessions',population:'sessions',currency:null,dimensions:{page:'/page'},quality:'complete'}]);
 await state.store.persistBatch('o','qualified',{clientId:'beam',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows} as any,'headline-references','2026-10-08T10:00:00Z');
 const result=await aiContext('beam',{...filters,view:'traffic'},undefined,undefined,false,true,'Traffic');const client=result.context.clients[0];
 expect(client.weekday).toMatchObject({metrics:{revenue:100},period:{from:'2026-09-30',to:'2026-09-30'}});expect(client.previousDay).toMatchObject({metrics:{revenue:200},period:{from:'2026-10-06',to:'2026-10-06'}});
 const references=spy.mock.calls.filter(call=>call[3].view==='overview'&&call[4]?.preparedDatasets?.join(',')==='overview');expect(references).toHaveLength(2);expect(references.every(call=>call[1].every(row=>row.dataset==='overview'))).toBe(true);expect(spy.mock.calls.find(call=>call[3].view==='traffic')?.[1].some(row=>row.dataset==='traffic')).toBe(true);
 const unsupported=(await aiContext('beam',{...filters,view:'traffic',device:'mobile'},undefined,undefined,false,true,'Traffic')).context.clients[0];expect(unsupported.weekday).toMatchObject({metrics:{revenue:null}});expect((unsupported.weekday as any).warnings.join(' ')).toContain('Unsupported metrics are unavailable');
 const partial=(await aiContext('beam',{...filters,view:'traffic',mode:'partial'},undefined,undefined,false,true,'Traffic')).context.clients[0];expect(partial.weekday).toMatchObject({metrics:{revenue:null}});expect((partial.weekday as any).warnings.join(' ')).toContain('confirmed, current hourly coverage');
 }finally{spy.mockRestore();}
});
it('uses supplied closed headline history for Beam daily-review weekday references without duplicating the selected day',async()=>{
 const selected={...filters,from:'2026-10-15',to:'2026-10-15'},human={definition:'shopify_human_us_sessions',population:'human_us_online_store_sessions'};
 const rows:Observation[]=[['2026-10-15',1000,10,1000,20],['2026-10-14',800,8,800,8],['2026-10-08',1200,12,1200,36]].flatMap(([date,revenue,orders,sessions,conversions])=>Object.entries({revenue,orders,sessions,converting_sessions:conversions}).map(([metric,value])=>({date:String(date),dataset:'overview',metric,value:Number(value),definition:'beam_shopify_net_sales_all_channels_excluding_faire',population:'beam_shopify_sales_excluding_faire',currency:metric==='revenue'?'USD':null,dimensions:{},sourceId:'qualified',retrievedAt:'2026-10-16T12:00:00Z',coverageThrough:'2026-10-16T04:00:00Z',quality:'complete',...['sessions','converting_sessions'].includes(metric)?human:{}})));
 const store=state.store as Store;
 await store.persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-16T04:00:00Z',rows},'beam-selected-weekday-review','2026-10-16T12:00:00Z');
 const read=store.observations.bind(store);
 // The selected/detail read may omit older headline dates; the review's
 // explicit closed-history read still supplies the exact weekday benchmark.
 const limited=vi.spyOn(store,'observations').mockImplementation(async(...args)=>{const found=await read(...args);return args[2]?.from===selected.from&&args[2]?.to===selected.to&&args[2]?.compare===selected.compare&&!args[3]?found.filter(row=>row.date>='2026-10-14'):found;});
 try{
 const result=await aiContext('beam',selected,undefined,undefined,true),c=result.context.clients[0];
 expect(c.metrics).toMatchObject({revenue:1000,orders:10,sessions:1000,cvr:.02});
 expect(c.previousDay).toMatchObject({period:{from:'2026-10-14',to:'2026-10-14'},metrics:{revenue:800,orders:8,sessions:800,cvr:.01}});
 expect(c.weekday).toMatchObject({period:{from:'2026-10-08',to:'2026-10-08'},metrics:{revenue:1200,orders:12,sessions:1200,cvr:.03}});
 expect(evidenceReviewTables(c,selected).find(table=>table.title==='Selected closed day vs previous day and weekday')?.rows).toEqual([['Selected closed day','2026-10-15','$1,000.00','10','1,000','2.00%'],['Previous closed day','2026-10-14','$800.00','8','800','1.00%'],['Same weekday','2026-10-08','$1,200.00','12','1,200','3.00%']]);
 expect(state.model).not.toHaveBeenCalled();
 }finally{limited.mockRestore();}
});

it('regenerates a saved report when the review standard changes while still deduplicating same-standard reruns',async()=>{
 await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated source review'},'2026-10-08T00:00:00Z');
 const context=(await aiContext('beam',filters,undefined,state.scope as any,true)).context;
 await state.store.saveReview('o','beam',filters.to,'legacy-model',{type:'ai',inputFingerprint:await fingerprint(context),headlines:['Legacy generation standard']},'2026-10-08T00:01:00Z');
 state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]})),sourceIds:[],actions:[]});
 const id=await generateAIReview(state.scope as any,'beam',filters);expect(state.model).toHaveBeenCalledTimes(1);
 expect((await state.store.reviews('o','beam')).find((r:any)=>r.id===id)?.payload.reviewStandardVersion).toBe('avenuez-beam-daily-v5');
 const input=JSON.parse(state.model.mock.calls[0][2]);expect(input.context.clients[0].qualifiedPageOpportunities).toEqual([]);
 expect(state.model.mock.calls[0][4]).toContain('exact dated numeric');
 await generateAIReview(state.scope as any,'beam',filters);expect(state.model).toHaveBeenCalledTimes(1);
});

it('loads dense review cuts only for selected and comparison days while retaining MTD, weekday headlines and renewal benchmarks',async()=>{
 const dates=['2026-09-09','2026-09-30','2026-10-01','2026-10-05','2026-10-06','2026-10-07'];
 const rows=dates.flatMap((date,i)=>[{date,dataset:'traffic',metric:'sessions',value:100+i,definition:'human',population:'human',currency:null,dimensions:{page:'/offer',market:'US'}},{date,dataset:'overview',metric:'revenue',value:100+i,definition:'net_sales',population:'sales',currency:'USD',dimensions:{}},{date,dataset:'subscriptions',metric:'recurring_revenue',value:50+i,definition:'renewals',population:'renewals',currency:'USD',dimensions:{}},{date,dataset:'subscriptions',metric:'recurring_orders',value:2,definition:'renewals',population:'renewals',currency:null,dimensions:{}},{date,dataset:'media',metric:'spend',value:10,definition:'spend',population:'ads',currency:'USD',dimensions:{channel:'meta'}}]);
 await state.store.persistBatch('o','qualified',{clientId:'beam',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows} as any,'review-history','2026-10-08T10:00:00Z');
 const read=vi.spyOn(state.store,'observations'),result=await aiContext('beam',filters,undefined,state.scope as any,true),loaded=await Promise.all(read.mock.results.map(r=>r.value));
 expect(loaded.every(rows=>rows.filter((r:any)=>r.dataset==='traffic').every((r:any)=>r.date>='2026-10-06'))).toBe(true);
 expect(result.context.clients[0].traffic?.storeDate).toBe('2026-10-07');expect((result.context.clients[0].weekday as any).metrics.revenue).toBe(101);
 expect(result.context.clients[0].dailyRenewals.find(day=>day.storeDate==='2026-10-01')?.revenue).toBe(52);
 expect(result.context.clients[0].closedRecurringWeeks?.comparison.revenue).toBe(50);expect(result.context.clients[0].channelMonthToDate.find(c=>c.dataset==='media')?.rows[0].metrics.spend).toBe(40);
});

it('attaches the authenticated cached GA4 frame to live Ask AI with its own source and no provider/model request',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-16T17:45:00Z')),outbound=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected provider request'));
 try{
  state.ga4Config=JSON.stringify({clientId:'test-ga4.apps.googleusercontent.com',clientSecret:'test-ga4-secret',propertyId:'292550743'});
  for(const date of ['2026-10-14','2026-10-15']){
   const metrics={sessions:date==='2026-10-15'?120:80,engagedSessions:60,ecommercePurchases:0,purchaseRevenue:0},dateHour=date.replaceAll('-','')+'08',capturedAt='2026-10-16T17:30:00Z';
   const items:Ga4CachedReport[]=(['total','hourly','detail'] as const).map(kind=>{
    const dimensions:Record<string,string>=kind==='total'?{}:kind==='hourly'?{dateHour}:{dateHour,landingPage:'/dream',countryId:'US',deviceCategory:'desktop',sessionSource:'google',sessionMedium:'organic',sessionCampaignName:'(organic)'};
    return {storeDate:date,kind,capturedAt,report:{rowCount:1,rows:[{dimensions,metrics}],dimensionHeaders:Object.keys(dimensions).map(name=>({name})),metricHeaders:Object.keys(metrics).map(name=>({name,type:name==='purchaseRevenue'?'TYPE_CURRENCY':'TYPE_INTEGER'})),metadata:{timeZone:'America/New_York',currencyCode:'USD'}}};
   });
   await saveGa4DayReports(state.store,'o','292550743',items);
  }
  const selected={...filters,from:'2026-10-15',to:'2026-10-15',view:'ga4',market:'US',source:'google',page:'/dream',device:'desktop'},result=await aiContext('beam',selected,undefined,undefined,false,true,'Explain this chart');
  expect(result.context.clients[0].ga4View).toMatchObject({available:true,current:{sessions:120,purchases:0,revenue:0},previous:{sessions:80},scope:{filters:selected,latestCapturedAt:'2026-10-16T17:30:00Z'}});
  expect(result.context.sources.some(source=>source.id==='ga4:beam')).toBe(true);expect(result.context.clients[0].selectedView.instruction).toContain('not GA4 coverage');
  expect(state.model).not.toHaveBeenCalled();expect(outbound).not.toHaveBeenCalled();
 }finally{clock.mockRestore();outbound.mockRestore();}
});
it('attaches explicit GA4 unavailability only when the displayed view or question requests it',async()=>{
 const requested=await aiContext('beam',filters,undefined,undefined,false,true,'What does Google Analytics show?');
 expect(requested.context.clients[0].ga4View).toMatchObject({available:false});expect(requested.context.clients[0].ga4View).not.toHaveProperty('current');
 const ordinary=await aiContext('beam',filters,undefined,undefined,false,true,'What is shown?');expect(ordinary.context.clients[0]).not.toHaveProperty('ga4View');expect(state.model).not.toHaveBeenCalled();
});
it('preserves GA4 landing pages and sources through their supported dashboard filter limits',()=>{
 const page='/'+ 'p'.repeat(2047),source='s'.repeat(512),parsed=parseAIRequest({clientId:'beam',filters:{...filters,view:'ga4',page,source,market:'m'.repeat(120),device:'d'.repeat(120)}});
 expect(parsed.filters.page).toBe(page);expect(parsed.filters.source).toBe(source);expect(parsed.filters.market).toHaveLength(120);expect(parsed.filters.device).toHaveLength(120);expect(state.model).not.toHaveBeenCalled();
});
it.each([['page',2049],['source',513],['market',121],['device',121],['view',501]] as const)('rejects a GA4 %s filter beyond its supported cap',(key,length)=>{
 expect(()=>parseAIRequest({filters:{...filters,view:'ga4',[key]:'x'.repeat(length)}})).toThrow('Filter too long');
});
it('keeps the existing 500-character per-filter limits outside GA4',()=>{
 for(const key of ['page','source'])expect(()=>parseAIRequest({filters:{...filters,[key]:'x'.repeat(501)}})).toThrow('Filter too long');
 expect(parseAIRequest({filters:{...filters,page:'x'.repeat(500),source:'s'.repeat(500)}}).filters.page).toHaveLength(500);
});

it('loads Beam displayed Shopify, cached Motion and Intelligems evidence for ordinary Ask AI without requesting subscription datasets',async()=>{
 const rows:Observation[]=[];
 for(const date of ['2026-10-06','2026-10-07']){
  const common={date,currency:'USD',dimensions:{},sourceId:'qualified',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T04:00:00Z',quality:'complete' as const};
  rows.push({...common,dataset:'overview',metric:'revenue',value:100,definition:'beam_shopify_net_sales_all_channels_excluding_faire',population:'beam_shopify_sales_excluding_faire'});
  rows.push({...common,dataset:'media',metric:'platform_spend',value:date.endsWith('07')?120:100,definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',coverageThrough:null,dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-08T04:46:00Z'}});
  rows.push({...common,dataset:'experiments',metric:'conversion_rate',value:.02,currency:null,definition:'intelligems_us_experiment_all_products_all_currencies_daily_visitors_zscore3',population:'intelligems_exposed_experiment_visitors',coverageThrough:null,dimensions:{report_date:date,experiment_id:'exp',experiment:'Expanded menu',variant_id:'b',variant:'New',status:'started',is_control:'false',market:'US'}});
 }
 await state.store.persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows} as any,'beam-ask-ai-platforms','2026-10-08T10:00:00Z');
 const reads=vi.spyOn(state.store,'observations'),result=await aiContext('beam',filters,undefined,undefined,false,true,'What is shown?'),c=result.context.clients[0];
 const loadedSelection=reads.mock.calls[0][5] as {datasets:string[]};expect(loadedSelection.datasets).toEqual(expect.arrayContaining(['overview','revenue','media','experiments']));expect(loadedSelection.datasets).not.toContain('subscriptions');expect(c.beamReporting?.motion.current.spend).toBe(120);expect(c.beamReporting?.experiments.current.rows[0].metrics.conversion_rate).toBe(.02);
 state.model.mockResolvedValue({answer:'The captured Meta provider-date spend is $120; experiment results are directional.',sourceIds:['selection:beam'],followUps:[],caveats:[]});await answerAI({clientId:'beam',filters,question:'What is shown?'});expect(state.model.mock.calls[0][2]).toContain('platform_spend');expect(state.model.mock.calls[0][2]).toContain('Expanded menu');
});
it('uses Beam media provider-date chart context in Ask AI without substituting the commerce revenue chart',async()=>{
 const rows=['2026-10-01','2026-10-06','2026-10-07'].map((date,index)=>({date,dataset:'media',metric:'platform_spend',value:(index+1)*100,definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',currency:'USD',dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-08T04:46:00Z'},sourceId:'qualified',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:null,quality:'complete' as const}));
 await state.store.persistBatch('o','qualified',{clientId:'beam',timezone:'America/New_York',currency:'USD',complete:true,coverageThrough:null,rows} as any,'beam-platform-chart','2026-10-08T10:00:00Z');
 const result=await aiContext('beam',{...filters,view:'media'},undefined,undefined,false,true,'Explain the seven-day spend chart'),chart=result.context.clients[0].selectedView.dailyChart!;expect(chart.dataset).toBe('media');expect(chart.current.find(day=>day.date==='2026-10-01')?.metrics.platform_spend).toBe(100);expect(chart.instruction).toContain('independent of Shopify');
});
