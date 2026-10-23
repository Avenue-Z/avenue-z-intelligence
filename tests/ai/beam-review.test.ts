import {expect,it} from 'vitest';
import clients from '../../data/initial-clients.json';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {buildAIContext,REVIEW_SECTIONS,type reviewSchema} from '../../lib/ai/context';
import {authoritativeBeamSpendReview} from '../../lib/reviews/beam-review';
import {evidenceReviewTables} from '../../lib/reviews/tables';
import {rankedReviewPages,refineReview} from '../../lib/reviews/refine';
import type {z} from 'zod';
const client={...clients[1],version:1} as Client,filters:QueryFilters={from:'2026-10-15',to:'2026-10-15',compare:'previous',view:'overview',mode:'closed',market:'',source:'',page:'',device:'',stream:''};
function row(date:string,dataset:string,metric:string,value:number,dimensions:Record<string,string>={},extra:Partial<Observation>={}):Observation{return {date,dataset,metric,value,dimensions,definition:dataset==='media'?'motion_meta_account_spend_provider_date_cached':'beam_shopify_net_sales_all_channels_excluding_faire',population:dataset==='media'?'motion_meta_account_report':'beam_shopify_sales_excluding_faire',currency:metric==='platform_spend'||metric==='revenue'?'USD':null,sourceId:dataset==='media'?'motion':'shopify',retrievedAt:'2026-10-16T12:00:00Z',coverageThrough:dataset==='media'?null:'2026-10-16T04:00:00Z',quality:'complete',...extra};}
function context(rows:Observation[],selected=filters){const r=queryClient(client,rows,[],selected);return buildAIContext([{...r,note:{body:'',version:0},findings:[],reviews:[]}],selected).clients[0];}
const spendRows=[row('2026-10-15','media','platform_spend',120,{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-16T04:46:43Z'}),row('2026-10-14','media','platform_spend',100,{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-15T04:44:49Z'})];
it('preserves independent provider report dates and reads complete account totals without inventing MER',()=>{
 const c=context([...spendRows,row('2026-10-15','overview','revenue',1100),row('2026-10-14','overview','revenue',1000)]),spend=authoritativeBeamSpendReview(c,filters)!;
 expect(c.beamReporting?.motion.current).toMatchObject({spend:120,reportedDays:1,complete:true,daily:[{reportDate:'2026-10-15',providerAsOf:'2026-10-16T04:46:43Z'}]});
 expect(spend.headline).toContain('Meta provider-date spend +20.0%');expect(spend.paragraph).toContain('account timezone is unverified');expect(spend.rows.some(r=>r[0].includes('Revenue / spend'))).toBe(false);expect(c.beamReporting?.instruction).toContain('outside the requested scope');
});
it('withholds spend growth when provider dates are missing or still open',()=>{
 const missing=context(spendRows,{...filters,from:'2026-10-14'}),a=authoritativeBeamSpendReview(missing,{...filters,from:'2026-10-14'})!;expect(a.headline).toContain('Meta provider-date spend unavailable');
 const open=context(spendRows.map(r=>({...r,quality:'partial'})));expect(authoritativeBeamSpendReview(open,filters)?.headline).toContain('Meta provider-date spend unavailable');
});
it('distinguishes missing matched-hour spend from an available partial Motion daily report without ruling out causes',()=>{
 const c=context([spendRows[0],spendRows[1]].map((r,index)=>index===0?{...r,quality:'partial'}:r));
 expect(c.metrics.spend).toBeNull();expect(c.beamReporting?.motion.current).toMatchObject({spend:120,closed:false,daily:[{reportDate:'2026-10-15',providerAsOf:'2026-10-16T04:46:43Z',closed:false}]});
 expect(c.beamReporting?.instruction).toMatch(/metrics\.spend=null.*matched-hour.*not absence of Motion daily data/);
 expect(c.beamReporting?.instruction).toMatch(/provider dates, providerAsOf and partial status/);
 expect(c.beamReporting?.instruction).toMatch(/Partial current-day.*closed-day.*cannot establish spend growth or pace/);
 expect(c.beamReporting?.instruction).toMatch(/cannot rule out spend or demand causes.*prove demand efficiency/);
});
it('keeps all-channel orders and Online Store financial orders separate from the US converting-session denominator',()=>{
 const online={definition:'beam_shopify_online_store_net_sales',population:'beam_shopify_online_store_sales'},human={definition:'shopify_human_us_sessions',population:'human_us_online_store_sessions'};
 const c=context([row(filters.to,'overview','orders',2235),row(filters.to,'overview','online_store_orders',196,{},online),row(filters.to,'overview','sessions',9125,{},human),row(filters.to,'overview','converting_sessions',193,{},human)]);
 expect(c.selectedView.current.metrics).toMatchObject({orders:2235,online_store_orders:196,sessions:9125,converting_sessions:193});expect(c.selectedView.current.summary.cvr).toBeCloseTo(193/9125);
 expect(c.beamReporting?.instruction).toMatch(/All-channel orders, Online Store financial orders and US converting sessions are separate populations/);
 expect(c.beamReporting?.instruction).toMatch(/US session CVR is converting_sessions\/sessions only/);
 expect(c.beamReporting?.instruction).toMatch(/Never explain US CVR with all-channel or financial orders/);
});
it('renders real Motion delivery and experiment confidence without unsupported pixel or money columns',()=>{
 const d={report_date:'2026-10-15',experiment_id:'exp',experiment:'Menu',variant_id:'b',variant:'New',status:'started',is_control:'false',market:'US'},rows=[...spendRows,row(filters.to,'creatives','motion_ad_spend',120,{ad_id:'ad',ad:'Actual ad',campaign:'Campaign',provider_as_of:'2026-10-16T04:46:43Z'}),row(filters.to,'creatives','motion_ad_impressions',1000,{ad_id:'ad',ad:'Actual ad',campaign:'Campaign',provider_as_of:'2026-10-16T04:46:43Z'}),...Object.entries({visitors:1000,orders:20,conversion_rate:.02,conversion_rate_lift:.1,conversion_rate_lift_ci_low:-.1,conversion_rate_lift_ci_high:.3}).map(([m,v])=>row(filters.to,'experiments',m,v,d))];
 const tables=evidenceReviewTables(context(rows),filters),creative=tables.find(t=>t.title==='Motion Meta ad delivery')!,experiment=tables.find(t=>t.title==='Intelligems US experiment daily results')!;expect(creative.rows[0]).toContain('$120.00');expect(creative.columns.join(' ')).not.toContain('Pixel');expect(experiment.rows[0]).toContain('-10.00%');expect(experiment.scope).toContain('Daily subsets are directional');
});
it('removes out-of-scope subscription actions and recurring requirements from Beam reviews',()=>{
 const c=context(spendRows),result:z.infer<typeof reviewSchema>={kpis:[],headlines:['Revenue','Subscription cancellations','Watch','Spend vs revenue'],summary:[],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:['Review Loop subscriptions'],bullets:[],tables:[]})),sourceIds:[],actions:[{existingFindingId:null,title:'Connect Loop subscription diagnostics',detail:'Subscriptions are missing',nextStep:'Connect Loop',severity:'investigate',impact:null,sourceIds:['selection:beam']}]};
 const refined=refineReview(result,c,filters);expect(refined.actions).toEqual([]);expect(refined.kpis.some(k=>k.label==='Meta platform spend')).toBe(true);expect(refined.kpis.some(k=>k.label==='Revenue / spend')).toBe(false);expect(refined.sections.find(s=>s.title==='Sources & limitations')?.paragraphs.join(' ')).not.toContain('Renewal currency, units and refunded money');
});
it('qualifies actual Beam US page populations at configured traffic and impact thresholds',()=>{
 const page={page:'/products/kids',market:'US'},base={definition:'shopify_human_us_public_landing_pages',population:'human_us_public_landing_page_sessions',currency:null};
 const c=context([row(filters.to,'funnels','sessions',1000,page,base),row(filters.to,'funnels','converting_sessions',10,page,base),row('2026-10-14','funnels','sessions',1000,page,base),row('2026-10-14','funnels','converting_sessions',30,page,base)]);
 const opportunity=rankedReviewPages(c,filters)[0];expect(opportunity).toMatchObject({page:'/products/kids',benchmarkReason:'Own previous period'});expect(opportunity.gap).toBeCloseTo(20);
});
it('seeds Beam closed daily reviews at 08:00 New York without subscriptions',()=>{expect(client.config).toMatchObject({reviewTime:'08:00',reviewTimezone:'America/New_York',reviewMode:'closed',minSessions:700,minOpportunity:5,subscriptionsEnabled:false});});
it('renders the selected closed day against its exact previous day and same weekday with matching US session CVR',()=>{
 const human={definition:'shopify_human_us_sessions',population:'human_us_online_store_sessions'},c=context([row(filters.to,'overview','revenue',1000),row(filters.to,'overview','orders',10),row(filters.to,'overview','sessions',1000,{},human),row(filters.to,'overview','converting_sessions',20,{},human)]);
 c.previousDay={period:{from:'2026-10-14',to:'2026-10-14'},metrics:{revenue:800,orders:8,sessions:800,cvr:.01}};
 c.weekday={period:{from:'2026-10-08',to:'2026-10-08'},metrics:{revenue:1200,orders:12,sessions:1200,cvr:.03}};
 const table=evidenceReviewTables(c,filters).find(t=>t.title==='Selected closed day vs previous day and weekday');
 expect(table?.rows).toEqual([['Selected closed day','2026-10-15','$1,000.00','10','1,000','2.00%'],['Previous closed day','2026-10-14','$800.00','8','800','1.00%'],['Same weekday','2026-10-08','$1,200.00','12','1,200','3.00%']]);
 expect(table?.columns).not.toContain('Spend');expect(table?.scope).toContain('US');expect(table?.sourceIds).toEqual(['selection:beam']);
});
it('keeps unknown daily benchmarks unavailable and refuses values from a different weekday date',()=>{
 const c=context([]);c.previousDay={period:{from:'2026-10-14',to:'2026-10-14'},metrics:{revenue:0,orders:0,sessions:0,cvr:null}};
 c.weekday={period:{from:'2026-10-07',to:'2026-10-07'},metrics:{revenue:999,orders:999,sessions:999,cvr:.99}};
 const table=evidenceReviewTables(c,filters).find(t=>t.title==='Selected closed day vs previous day and weekday');
 expect(table?.rows[0]).toEqual(['Selected closed day','2026-10-15','Unavailable','Unavailable','Unavailable','Unavailable']);
 expect(table?.rows[1]).toEqual(['Previous closed day','2026-10-14','$0.00','0','0','Unavailable']);
 expect(table?.rows[2]).toEqual(['Same weekday','2026-10-08','Unavailable','Unavailable','Unavailable','Unavailable']);
 expect(JSON.stringify(table)).not.toContain('999');
 expect(evidenceReviewTables(c,{...filters,mode:'partial'}).some(t=>t.title==='Selected closed day vs previous day and weekday')).toBe(false);
});
it('removes excluded cancellation capture and AppLovin clauses from final Beam limitations while preserving genuine missing evidence',()=>{
 const c=context(spendRows);c.strategyDiagnoses.limitations=['Calendar cancellation capture is incomplete. Selected missing dates: 2026-10-15. Missing dates are unknown, not zero.','Market-level CPC, CPM and CTR are unavailable: the supplied click/impression feed has no country breakdown. AppLovin UTC market spend cannot establish store-day market traffic costs.','Page-family AOV requires compatible page-attributed revenue and commerce orders.'];
 const result:z.infer<typeof reviewSchema>={kpis:[],headlines:['Revenue','Traffic','Watch','Spend vs revenue'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]})),sourceIds:[],actions:[]};
 const limits=refineReview(result,c,filters).sections.find(s=>s.title==='Sources & limitations')!.paragraphs.join(' ');
 expect(limits).not.toMatch(/Calendar cancellation capture|Selected missing dates: 2026-10-15|AppLovin/);
 expect(limits).toContain('Market-level CPC, CPM and CTR are unavailable');expect(limits).toContain('Page-family AOV requires compatible page-attributed revenue');expect(limits).toContain('account timezone');
});
it('preserves KP cancellation capture and AppLovin limitations without adding Beam headline tables',()=>{
 const kp={...clients[0],version:1} as Client,r=queryClient(kp,[],[],filters),c=buildAIContext([{...r,note:{body:'',version:0},findings:[],reviews:[]}],filters).clients[0];
 c.strategyDiagnoses.limitations=['Calendar cancellation capture is incomplete. Missing dates are unknown, not zero.','AppLovin UTC market spend cannot establish store-day market traffic costs.'];
 const result:z.infer<typeof reviewSchema>={kpis:[],headlines:['Revenue','Traffic','Watch','Spend vs revenue'],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]})),sourceIds:[],actions:[]};
 const limits=refineReview(result,c,filters).sections.find(s=>s.title==='Sources & limitations')!.paragraphs.join(' ');
 expect(limits).toContain('Calendar cancellation capture is incomplete');expect(limits).toContain('AppLovin UTC');expect(evidenceReviewTables(c,filters).some(table=>table.title==='Selected closed day vs previous day and weekday')).toBe(false);
});
