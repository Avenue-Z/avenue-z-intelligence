import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {vi,it,expect,beforeEach} from 'vitest';
import {Store} from '../../lib/server/store';
import {authorize} from '../../lib/server/policy';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as any,scope:{organizationId:'o',actorId:'u',role:'analyst',permittedClientIds:['beam']},model:vi.fn()}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store,requireClientAccess:async(id?:string)=>authorize(state.scope as any,id)}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='OPENAI_API_KEY'?'test-only':null}));
vi.mock('../../lib/ai/provider',()=>({askOpenAI:state.model}));
import {aiContext,aiHistory,answerAI,generateAIReview} from '../../lib/ai/server';
import {REVIEW_SECTIONS,compactAIContextForModel} from '../../lib/ai/context';
import {fingerprint} from '../../lib/reviews/build';
import type {Observation,Connection} from '../../lib/analytics/contracts';
const filters={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview',market:'',source:'',page:'',device:'',stream:''} as const;
function database(){const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))db.exec(readFileSync(`drizzle/${f}`,'utf8'));return {prepare(sql:string){let values:any[]=[];const p={bind(...v:any[]){values=v;return p;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return p;},async batch(statements:any[]){db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};}
beforeEach(async()=>{state.store=new Store(database());state.model.mockReset();for(const c of clients)await state.store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',c.id,'o',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);});
it('rejects a forbidden client and an unrelated review before any model request',async()=>{await expect(answerAI({clientId:'kind-patches',filters,question:'Give me their revenue'})).rejects.toThrow('access');await expect(aiContext('beam',filters,'kind-only-review')).rejects.toThrow('access');expect(state.model).not.toHaveBeenCalled();});
it('answers a saved AI review from its original evidence even after live snapshots change',async()=>{
 const batch={clientId:'beam',complete:true,coverageThrough:'2026-10-08T04:00:00Z',rows:[{date:filters.to,dataset:'overview',metric:'revenue',value:100,definition:'net_sales',population:'sales',currency:'USD',dimensions:{}}]} as any;
 await state.store.persistBatch('o','qualified',batch,'original','2026-10-08T10:00:00Z');const original=(await aiContext('beam',filters)).context;
 const id=await state.store.saveReview('o','beam',filters.to,'fixed',{type:'ai',filters,evidence:compactAIContextForModel(original),headlines:['Revenue was $100']},'2026-10-08T10:01:00Z');
 await state.store.persistBatch('o','qualified',{...batch,rows:batch.rows.map((r:any)=>({...r,value:999}))},'changed','2026-10-08T11:00:00Z');
 const fixed=await aiContext('beam',{...filters,to:'2026-10-08'},id);expect(fixed.context.clients[0].metrics.revenue).toBe(100);expect(fixed.context.filters.to).toBe(filters.to);expect(fixed.context.clients[0].selectedReview?.revision).toBe(1);expect(fixed.context.sources.some(s=>s.id===`review:${id}`)).toBe(true);
});
it('recomputes server context, ignores a forged scope key, and isolates persisted history by actor',async()=>{state.model.mockResolvedValue({answer:'No evidence in this window',sourceIds:['selection:beam'],followUps:[],caveats:['Historical only']});await answerAI({clientId:'beam',filters,scopeKey:'forged',question:'What is shown?'});const a=await aiContext('beam',filters);expect(await aiHistory(a.s,a.scope,a.scopeKey)).toHaveLength(1);expect(await aiHistory(a.s,{...a.scope,actorId:'other'},a.scopeKey)).toEqual([]);expect(await aiHistory(a.s,{...a.scope,organizationId:'other'},a.scopeKey)).toEqual([]);expect(await aiHistory(a.s,a.scope,'forged')).toEqual([]);expect(state.model.mock.calls[0][2]).toContain('2026-10-07');});
it('preserves the source report and deduplicates AI reruns against unchanged original evidence',async()=>{await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated review'},'2026-10-08T00:00:00Z');state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Unavailable'],bullets:[],table:{columns:[],rows:[]}})),sourceIds:[],actions:[]});await generateAIReview(state.scope as any,'beam',filters);await generateAIReview(state.scope as any,'beam',filters);expect(state.model).toHaveBeenCalledTimes(1);const r=await state.store.reviews('o','beam');expect(r).toHaveLength(2);expect(r.find((x:any)=>x.revision===1).payload.text).toBe('Original dated review');});
it('preserves a dated AI recheck and renders its next step even if the model left the action section empty',async()=>{await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated review'},'2026-10-08T00:00:00Z');await state.store.saveFinding('o','beam',{id:'existing',title:'Review landing page traffic mix',detail:'Check paid traffic',severity:'investigate',owner:'Team',status:'open',evidence:[]},'u',0);state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Unavailable'],bullets:[],table:{columns:[],rows:[]}})),sourceIds:[],actions:[{existingFindingId:'existing',title:'Investigate traffic dilution on the PDP',detail:'Same issue under different wording',nextStep:'Check paid traffic',severity:'investigate',impact:null,sourceIds:['selection:beam']}]});await generateAIReview(state.scope as any,'beam',filters);const payload=(await state.store.reviews('o','beam'))[0].payload as any;expect(payload.actions).toEqual([]);expect(payload.watchActions).toMatchObject([{existingFindingId:'existing',nextStep:'Check paid traffic',sourceIds:['selection:beam']}]);expect(payload.sections.find((s:any)=>s.title==='Watch list').bullets.join(' ')).toContain('Check paid traffic');expect(state.model.mock.calls[0][2]).toContain('existing');});
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

it('regenerates a saved report when the review standard changes while still deduplicating same-standard reruns',async()=>{
 await state.store.saveReview('o','beam',filters.to,'original',{type:'historical',text:'Original dated source review'},'2026-10-08T00:00:00Z');
 const context=(await aiContext('beam',filters,undefined,state.scope as any,true)).context;
 await state.store.saveReview('o','beam',filters.to,'legacy-model',{type:'ai',inputFingerprint:await fingerprint(context),headlines:['Legacy generation standard']},'2026-10-08T00:01:00Z');
 state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Metric',value:'Unavailable',note:'Not supplied'})),headlines:['Historical source','Spend vs revenue unconfirmed','No live metrics','Check source'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]})),sourceIds:[],actions:[]});
 const id=await generateAIReview(state.scope as any,'beam',filters);expect(state.model).toHaveBeenCalledTimes(1);
 expect((await state.store.reviews('o','beam')).find((r:any)=>r.id===id)?.payload.reviewStandardVersion).toBe('avenuez-daily-v3');
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
