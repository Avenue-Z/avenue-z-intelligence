import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';
import clients from '../../data/initial-clients.json';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {buildAIContext,REVIEW_SECTIONS} from '../../lib/ai/context';
import {authoritativeBeamSpendReview} from '../../lib/reviews/beam-review';
import {evidenceReviewTables} from '../../lib/reviews/tables';
import {Store} from '../../lib/server/store';
const state=vi.hoisted(()=>({store:null as unknown as Store,model:vi.fn()}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store,requireClientAccess:async()=>{throw Error('Explicit service scope required');}}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(key:string)=>key==='OPENAI_API_KEY'?'test-only':null}));
vi.mock('../../lib/ai/provider',()=>({askOpenAI:state.model}));
import {generateAIReview} from '../../lib/ai/server';
const client={...clients.find(c=>c.id==='autobrush')!,version:1} as Client;
const filters:QueryFilters={from:'2026-10-21',to:'2026-10-21',compare:'previous',view:'overview',mode:'closed',market:'',source:'',page:'',device:'',stream:''};
function observation(date:string,dataset:string,metric:string,value:number,dimensions:Record<string,string>={},extra:Partial<Observation>={}):Observation{
 return {date,dataset,metric,value,dimensions,definition:'shopify_net_sales_all_channels',population:'shopify_sales',currency:metric==='revenue'?'USD':null,sourceId:'shopify',retrievedAt:'2026-10-22T12:00:00Z',coverageThrough:'2026-10-22T04:00:00Z',quality:'complete',...extra};
}
function evidence(){
 const rows=['2026-10-20','2026-10-21'].flatMap((date,index)=>[
  observation(date,'overview','revenue',index?1000:800),observation(date,'overview','orders',index?20:16),
  ...Object.entries({sessions:index?1000:800,converting_sessions:index?20:16}).map(([metric,value])=>observation(date,'overview',metric,value,{}, {definition:'shopify_human_sessions',population:'human_online_store_sessions'})),
  observation(date,'media','platform_spend',index?120:100,{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:date==='2026-10-21'?'2026-10-22T05:00:00Z':'2026-10-21T05:00:00Z'},{definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',currency:'USD',sourceId:'motion',coverageThrough:null})
 ]);
 const delivery={ad_id:'ad',ad:'Actual Autobrush ad',campaign:'Campaign',provider_as_of:'2026-10-22T05:00:00Z'};
 rows.push(...Object.entries({motion_ad_spend:120,motion_ad_impressions:1000,motion_ad_clicks:25}).map(([metric,value])=>observation(filters.to,'creatives',metric,value,delivery,{definition:'motion_meta_per_ad_delivery_provider_date_cached',population:'motion_meta_ad_report',currency:metric==='motion_ad_spend'?'USD':null,sourceId:'motion',coverageThrough:null})));
 const experiment={report_date:filters.to,experiment_id:'experiment',experiment:'Brush offer',variant_id:'b',variant:'Variation',status:'started',is_control:'false'};
 rows.push(...Object.entries({visitors:1000,orders:20,conversion_rate:.02,conversion_rate_lift_ci_low:-.1,conversion_rate_lift_ci_high:.3}).map(([metric,value])=>observation(filters.to,'experiments',metric,value,experiment,{definition:'intelligems_all_countries_experiment_all_products_all_currencies_daily_visitors_zscore3',population:'intelligems_exposed_experiment_visitors',currency:null,sourceId:'experiments',coverageThrough:null})));
 return rows;
}
function context(rows=evidence(),selected=filters){const analytics=queryClient(client,rows,[],selected);return buildAIContext([{...analytics,note:{body:'',version:0},findings:[],reviews:[]}],selected).clients[0];}
it('reports all-channel Shopify sales alongside independent Motion dates without a Beam market or channel exclusion',()=>{
 const c=context(),spend=authoritativeBeamSpendReview(c,filters);
 expect(spend).not.toBeNull();
 expect(spend?.paragraph).toContain('all-channel net sales');expect(spend?.paragraph).toContain('$120.00 versus $100.00');
 expect(spend?.headline).toContain('Meta provider-date spend +20.0%');expect(spend?.paragraph).toContain('account timezone is unverified');
 expect(JSON.stringify(spend)).not.toMatch(/Faire|US human|Revenue \/ spend/);
 expect(c.metrics.spend).toBeNull();expect(c.metrics.mer).toBeNull();
});
it('keeps partial Motion spend available while withholding its growth and hourly efficiency',()=>{
 const c=context(evidence().map(row=>row.dataset==='media'&&row.date===filters.to?{...row,quality:'partial'}:row)),spend=authoritativeBeamSpendReview(c,filters);
 expect(spend).not.toBeNull();
 expect(spend?.paragraph).toContain('$120.00 versus $100.00');expect(spend?.headline).toContain('Meta provider-date spend unavailable');
 expect(spend?.paragraph).toContain('matched MER and hourly efficiency are unavailable');
});
it('renders actual Motion delivery and global experiment confidence in the numeric appendix',()=>{
 const tables=evidenceReviewTables(context(),filters),delivery=tables.find(table=>table.title==='Motion Meta ad delivery'),experiments=tables.find(table=>table.title==='Intelligems All-country experiment daily results');
 expect(delivery).toBeDefined();expect(experiments).toBeDefined();
 expect(delivery?.rows[0]).toContain('$120.00');expect(delivery?.rows[0]).toContain('25');expect(delivery?.columns.join(' ')).not.toContain('Pixel');
 expect(experiments?.rows[0]).toContain('-10.00%');expect(experiments?.scope).toContain('Daily subsets are directional');
 expect(JSON.stringify(tables)).not.toMatch(/Faire|Human US|Intelligems US|Closed-day MER/);
});
function database(){const db=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))db.exec(readFileSync(`drizzle/${file}`,'utf8'));return {prepare(sql:string){let values:any[]=[];const statement={bind(...input:any[]){values=input;return statement;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return statement;},async batch(statements:any[]){db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};}
beforeEach(()=>{state.store=new Store(database());state.model.mockReset();});
it('saves a real Autobrush daily review with provider spend and no excluded subscription requirements',async()=>{
 const s=state.store;await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'org',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 const rows=evidence();for(const sourceId of ['shopify','motion','experiments'])await s.persistBatch('org',sourceId,{clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions:[],grain:sourceId==='shopify'?'daily':'provider-date',complete:true,coverageThrough:sourceId==='shopify'?'2026-10-22T04:00:00Z':null,rows:rows.filter(row=>row.sourceId===sourceId)},'captured','2026-10-22T12:00:00Z');
 state.model.mockResolvedValue({kpis:Array.from({length:4},()=>({label:'Model metric',value:'Unavailable',note:'Application supplies figures'})),headlines:['Revenue','Traffic','Subscription cancellation check','Spend vs revenue'],summary:['Traffic summary','Spend summary'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Review recurring subscriptions'],bullets:[],tables:[]})),sourceIds:['selection:autobrush'],actions:[{existingFindingId:null,title:'Review renewal cancellations',detail:'Review 10 subscription cancellations versus 5 yesterday',nextStep:'Check the subscription cohort',severity:'investigate',impact:null,sourceIds:['selection:autobrush']}]});
 const id=await generateAIReview({organizationId:'org',actorId:'scheduler',role:'admin',permittedClientIds:['autobrush']},client.id,filters);
 const review=(await s.reviews('org',client.id)).find(review=>review.id===id)!;const payload=review.payload as any;
 expect(payload.kpis.find((kpi:any)=>kpi.label==='Meta platform spend')?.value).toBe('$120.00');
 expect(payload.summary[1]).toContain('$120.00 versus $100.00');expect(payload.actions).toEqual([]);
 const report=JSON.stringify({kpis:payload.kpis,summary:payload.summary,headlines:payload.headlines,sections:payload.sections});
 expect(report).not.toMatch(/Faire|US human|Human US|US exposed|Review renewal|Review recurring|Renewal currency|Closed recurring week|Subscription cancellation check|Review 10 subscription|Loop|Amplitude|Revenue \/ spend|Closed-day MER/i);
 expect(payload.sections.find((section:any)=>section.title==='Detail tables').tables.some((table:any)=>table.title==='Motion Meta ad delivery')).toBe(true);
 expect(payload.sections.find((section:any)=>section.title==='Detail tables').tables.some((table:any)=>table.title==='Intelligems All-country experiment daily results')).toBe(true);
 expect(await s.reviews('org','beam')).toEqual([]);
});
