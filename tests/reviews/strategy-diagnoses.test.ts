import {expect,it} from 'vitest';
import {strategyDiagnoses} from '../../lib/reviews/diagnoses';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
import {buildAIContext,REVIEW_SECTIONS} from '../../lib/ai/context';
import {queryClient} from '../../lib/analytics/query';
import {evidenceReviewTables} from '../../lib/reviews/tables';
import {refineReview} from '../../lib/reviews/refine';
import clients from '../../data/initial-clients.json';
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',mode:'closed',compare:'previous',view:'overview',market:'',source:'',device:'',stream:'',page:''};
const prior={from:'2026-10-10',to:'2026-10-10'},client={timezone:'UTC',currency:'USD'};
function facts(date:string,dataset:string,dimensions:Record<string,string>,values:Record<string,number|null>):Observation[]{return Object.entries(values).map(([metric,value])=>({date,dataset,dimensions,metric,value,sourceId:`source:${dataset}`,population:dataset==='creatives'?'meta_platform_ad_report':'human_public_landing_page_sessions',definition:dataset==='creatives'?'meta_per_ad_platform_account_attribution_pixel_purchase_closed_store_day':'shopify_human_public_landing_page_traffic',currency:metric==='meta_ad_spend'?'USD':null,retrievedAt:'2026-10-12T10:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'}));}
const ad=(date:string,id:string,spend:number,clicks:number,impressions:number)=>facts(date,'creatives',{campaign_id:'1',campaign:'Prospecting',ad_id:id,reporting_timezone:'UTC',attribution:'account'},{meta_ad_spend:spend,meta_ad_clicks:clicks,meta_ad_impressions:impressions});
const page=(date:string,path:string,sessions:number,conversions:number)=>facts(date,'traffic',{page:path,market:'US',source:'social'},{sessions,converting_sessions:conversions});
it('pools Meta campaign denominators before deriving costs and never mistakes pixel value for store revenue',()=>{
 const d=strategyDiagnoses(client,filters,prior,[...ad(filters.to,'11',60,20,1000),...ad(filters.to,'12',40,80,1000)],ad(prior.to,'10',50,50,1000));
 expect(d.campaignCosts.rows[0]).toMatchObject({campaign:'Prospecting',campaignId:'1',current:{spend:100,clicks:100,impressions:2000,cpc:1,cpm:50,ctr:.05},comparison:{spend:50,clicks:50,impressions:1000,cpc:1,cpm:50,ctr:.05},changes:{spend:1,clicks:1,cpc:0}});
 expect(d.campaignCosts.rows[0].explanation).toContain('Spend and clicks moved proportionally');expect(d.limitations.join(' ')).toContain('Market-level CPC');expect(d.campaignCosts.scope).toContain('Pixel');
});
it('keeps missing comparisons, zero denominators and mismatched account timezones unknown',()=>{
 const d=strategyDiagnoses(client,filters,prior,ad(filters.to,'11',100,0,0),[]);expect(d.campaignCosts.rows[0].current.cpc).toBeNull();expect(d.campaignCosts.rows[0].current.cpm).toBeNull();expect(d.campaignCosts.rows[0].comparison.spend).toBeNull();expect(d.campaignCosts.rows[0].changes.spend).toBeNull();
 const bad=ad(filters.to,'11',100,10,100);bad.forEach(r=>r.dimensions.reporting_timezone='America/New_York');const invalid=strategyDiagnoses(client,filters,prior,bad,ad(prior.to,'10',100,10,100));expect(invalid.campaignCosts.rows[0].current.spend).toBeNull();expect(invalid.limitations.join(' ')).toContain('reporting timezone');
});
it('decomposes the complete human-page CVR move into changed session mix and within-family rates',()=>{
 const current=[...page(filters.to,'/',50,10),...page(filters.to,'/pages/dream-mag',150,15)],previous=[...page(prior.to,'/',100,20),...page(prior.to,'/pages/dream-mag',100,10)];
 const d=strategyDiagnoses(client,filters,prior,current,previous),market=d.pageFamilyMix.markets[0];expect(market.decomposition).toMatchObject({comparisonCvr:.15,currentCvr:.125,counterfactualCvr:.125,ratePoints:0});expect(market.decomposition!.mixPoints).toBeCloseTo(-.025);
 expect(market.families.find(r=>r.family==='Homepage')).toMatchObject({current:{sessions:50,sessionShare:.25},comparison:{sessions:100,sessionShare:.5}});
 expect(d.pageFamilyMix.aovDecomposition).toBeNull();expect(d.limitations.join(' ')).toContain('page-attributed revenue and commerce orders');
});
it('does not classify a named LP as a single SKU or treat unmatched new-family conversion as an old rate',()=>{
 const d=strategyDiagnoses(client,filters,prior,page(filters.to,'/pages/burn-offer',200,20),page(prior.to,'/',200,40));expect(d.pageFamilyMix.markets[0].families.map(r=>r.family)).toContain('Landing page (offer type unknown)');expect(d.pageFamilyMix.markets[0].decomposition).toBeNull();
});
it('qualifies coverage before decomposition and does not pool different metric populations',()=>{
 const current=page(filters.to,'/',200,40),previous=page(prior.to,'/',200,20);current.find(r=>r.metric==='converting_sessions')!.population='different_population';
 const d=strategyDiagnoses(client,filters,prior,current,previous);expect(d.pageFamilyMix.markets[0].families[0].current.cvr).toBeNull();expect(d.pageFamilyMix.markets[0].decomposition).toBeNull();
 const multi=strategyDiagnoses(client,{...filters,from:'2026-10-10'},prior,page(filters.to,'/',200,40),previous);expect(multi.pageFamilyMix.currentCoverage.missingDates).toEqual(['2026-10-10']);expect(multi.pageFamilyMix.markets[0].decomposition).toBeNull();
});
it('states exact captured cancellation dates and never fills missing days with zero or renewal order cancellations',()=>{
 const event=(date:string,value:number)=>facts(date,'subscriptionEvents',{}, {subscription_cancellations:value}).map(r=>({...r,population:'recharge_cancelled_subscription_records',definition:'recharge_current_cancelled_subscription_records_cancelled_at_utc_to_store_date_excludes_reactivated'}));
 const d=strategyDiagnoses(client,{...filters,from:'2026-10-10'},prior,[...event('2026-10-11',7),...facts('2026-10-11','subscriptions',{}, {recurring_cancelled_orders:99})],[]);
 expect(d.calendarCancellations.current).toMatchObject({observedDates:['2026-10-11'],missingDates:['2026-10-10'],total:null,rows:[{date:'2026-10-10',cancellations:null},{date:'2026-10-11',cancellations:7}]});expect(d.calendarCancellations.comparison.total).toBeNull();expect(d.calendarCancellations.change).toBeNull();expect(d.calendarCancellations.scope).toMatch(/reactivated/i);
});
it('retains complete campaign aggregates before the 80-ad evidence preview and renders exact dated costs',()=>{
 const brand={...clients[0],timezone:'UTC',currency:'USD'} as any,current=Array.from({length:120},(_,i)=>ad(filters.to,String(i+1000),1,2,20)).flat(),previous=Array.from({length:60},(_,i)=>ad(prior.to,String(i+1000),1,2,20)).flat();
 const analytics=queryClient(brand,[...current,...previous],[],filters),context=buildAIContext([{...analytics,note:{body:''},findings:[],reviews:[]}] as any,filters),c=context.clients[0];
 expect(c.datasetDetails.creatives).toMatchObject({segmentCount:120,returnedSegmentCount:80,omitted:40});expect(c.strategyDiagnoses.campaignCosts.rows[0].current).toMatchObject({spend:120,clicks:240,impressions:2400,cpc:.5,cpm:50,ctr:.1});
 const costs=evidenceReviewTables(c,filters).find(table=>table.title==='Meta campaign traffic costs vs comparison')!;expect(costs.rows[0]).toContain('$120.00');expect(costs.rows[0]).toContain('$60.00');expect(costs.sourceIds).toEqual([c.sourceId]);expect(costs.scope).toContain(`${filters.to}–${filters.to} vs ${prior.to}–${prior.to}`);
});
it('renders calendar cancellations separately and keeps unavailable diagnosis limits after deterministic refinement',()=>{
 const brand={...clients[0],timezone:'UTC',currency:'USD'} as any,event=facts(filters.to,'subscriptionEvents',{}, {subscription_cancellations:7}).map(row=>({...row,population:'recharge_cancelled_subscription_records',definition:'recharge_current_cancelled_subscription_records_cancelled_at_utc_to_store_date_excludes_reactivated'}));
 const analytics=queryClient(brand,event,[],filters),context=buildAIContext([{...analytics,note:{body:''},findings:[],reviews:[]}] as any,filters),c=context.clients[0],result={headlines:['Spend vs revenue','B','C','D'],actions:[],sections:REVIEW_SECTIONS.map(title=>({title,paragraphs:[],bullets:[],tables:[]}))} as any;
 refineReview(result,c,filters);const details=result.sections.find((section:any)=>section.title==='Detail tables').tables,table=details.find((table:any)=>table.title==='Subscription cancellations by store calendar day');expect(table.rows).toEqual([[filters.to,'7',prior.to,'Unavailable']]);expect(table.scope).toMatch(/comparison missing dates: 2026-10-10/i);
 const limits=result.sections.find((section:any)=>section.title==='Sources & limitations').paragraphs.join(' ');expect(limits).toContain('Market-level CPC');expect(limits).toContain('Page-family AOV');expect(limits).toContain('Missing dates are unknown');const once=JSON.stringify(result);refineReview(result,c,filters);expect(JSON.stringify(result)).toBe(once);
});
