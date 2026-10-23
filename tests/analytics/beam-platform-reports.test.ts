import {expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import type {Client,Connection,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {TrendRollupAccumulator} from '../../lib/analytics/trend-rollup';
import {FunnelRollupAccumulator} from '../../lib/analytics/funnel-rollup';
import {intradayConnections} from '../../lib/analytics/intraday-coverage';
import {validateBatch} from '../../lib/sources/qualification';
const client={...initial.find(value=>value.id==='beam')!,version:1} as Client;
const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',compare:'previous',mode:'partial',view:'overview',market:'',stream:'',source:'',device:'',page:''};
const row=(date:string,metric:string,value:number):Observation=>({date,metric,value,dataset:'overview',definition:'beam_shopify_net_sales_all_channels_excluding_faire',population:'beam_shopify_sales_excluding_faire',currency:'USD',dimensions:{},sourceId:'sales',retrievedAt:'2026-10-16T15:10:00Z',coverageThrough:'2026-10-16T15:00:00Z',quality:'complete',start:`${date}T14:00:00Z`,end:`${date}T15:00:00Z`});
const spend=(date:string,value:number):Observation=>({...row(date,'platform_spend',value),dataset:'media',definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',sourceId:'motion',dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-16T14:30:00Z'},start:undefined,end:undefined,coverageThrough:null});
it('keeps platform calendar spend on its reported dates while matching Shopify to yesterday exact hour',()=>{
 const sources=[{provider:'beam-shopify-sales',enabled:true,coverageThrough:'2026-10-16T15:00:00Z'},{provider:'beam-shopify-sessions',enabled:true,coverageThrough:'2026-10-16T16:00:00Z'},{provider:'beam-motion',enabled:true,coverageThrough:null}] as Connection[];
 const late={...row('2026-10-15','revenue',900),start:'2026-10-15T15:00:00Z',end:'2026-10-15T16:00:00Z'};
 const a=queryClient(client,[row(filters.to,'revenue',100),row('2026-10-15','revenue',80),late,spend(filters.to,20),spend('2026-10-15',25)],sources,filters,{preparedDatasets:['overview','media']});
 expect(a.metrics.revenue).toBe(100);expect(a.prior.revenue).toBe(80);expect(a.cutoff).toBe('2026-10-16T15:00:00Z');
 expect(a.datasetSeries.media[0].metrics.platform_spend).toBe(20);expect(a.comparisonDatasetSeries.media[0].metrics.platform_spend).toBe(25);
 expect(a.metrics.spend).toBeNull();expect(a.metrics.mer).toBeNull();expect(a.verdict.growth).toBe('unavailable');
 expect(intradayConnections(sources,'overview').map(source=>source.provider)).toEqual(['beam-shopify-sales','beam-shopify-sessions']);
});
it('retains verified platform history in partial trend rollups without inventing source hour coverage',()=>{
 const accumulator=new TrendRollupAccumulator(filters,{timezone:client.timezone,cutoff:'2026-10-16T15:00:00Z',anchorDate:filters.to});accumulator.add(spend('2026-10-15',25));
 const [point]=accumulator.finish();expect(point.value).toBe(25);expect(point.end).toBeUndefined();expect(point.coverageThrough).toBeNull();
});
it('does not exempt ordinary unqualified daily sales from the matched-hour guard',()=>{
 const daily={...row(filters.to,'revenue',99),start:undefined,end:undefined};
 const a=queryClient(client,[daily,spend(filters.to,20)],[],filters,{preparedDatasets:['overview','media']});expect(a.metrics.revenue).toBeNull();expect(a.evidence).toEqual([spend(filters.to,20)]);
});
it('compacts verified sparse US landing-page traffic without changing its population or count',()=>{
 const accumulator=new FunnelRollupAccumulator({timezone:client.timezone});
 const traffic:Observation={...row(filters.to,'sessions',4),currency:null,dataset:'traffic',definition:'shopify_human_us_public_landing_page_traffic',population:'human_us_public_landing_page_sessions',dimensions:{page:'/products/dream',market:'US',device:'mobile',source:'Meta',utm_source:'facebook',utm_medium:'paid',utm_campaign:'dream'}};
 accumulator.add(traffic);accumulator.add({...traffic,value:3,start:'2026-10-16T13:00:00Z',end:'2026-10-16T14:00:00Z'});const [point]=accumulator.finish();expect(point.value).toBe(7);expect(point.population).toBe(traffic.population);expect(point.contributionCount).toBe(2);
});
it('rejects expanded traffic privileges for another client or non-traffic profile',()=>{
 const batch={clientId:'beam',timezone:client.timezone,currency:'USD',channels:[],dimensions:[],grain:'hourly',complete:true,coverageThrough:'2026-10-16T15:00:00Z',rows:[row(filters.to,'revenue',1)]};
 expect(()=>validateBatch(batch,'beam',{beamTrafficHourly:true})).toThrow(/qualified Beam/);
 expect(()=>validateBatch({...batch,clientId:'kind-patches'},'kind-patches',{beamTrafficHourly:true})).toThrow(/registered client/);
});
