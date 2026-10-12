import {expect,it} from 'vitest';
import {chooseBenchmark} from '../../lib/analytics/benchmark';
import {detailRows,queryClient} from '../../lib/analytics/query';
import {buildAIContext} from '../../lib/ai/context';
import {rankedReviewPages} from '../../lib/reviews/refine';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'test',name:'Test client',slug:'test',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['FR','DE'],benchmarkMarket:'France',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:1000,minOpportunity:20,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'funnels'};
const rows:Observation[]=['France','Germany'].flatMap((market,i)=>['sessions','converting_sessions'].map(metric=>({date:filters.to,dataset:'funnels',metric,value:metric==='sessions'?1000:i?50:100,dimensions:{page:'/landing',market},definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'})));

it.each(['France','FR'])('retains the same German 50-session opportunity for a %s benchmark configuration',benchmarkMarket=>{
 const configured={...client,config:{...client.config,benchmarkMarket}},a=queryClient(configured,rows,[],filters);
 expect(a.actions).toHaveLength(1);
 expect(a.actions[0]).toMatchObject({dimensions:{market:'DE'},benchmark:.1,benchmarkReason:'Same page in benchmark market'});
 expect(a.actions[0].opportunity).toBeCloseTo(50);
 expect(configured.config.benchmarkMarket).toBe(benchmarkMarket);
 expect(a.client).toBe(configured);
});

it('matches benchmark and saved row aliases without self-benchmarking or rewriting their dimensions',()=>{
 const saved=detailRows(rows),fr=saved.find(r=>r.dimensions.market==='France')!,de=saved.find(r=>r.dimensions.market==='Germany')!;
 const b=chooseBenchmark(de,saved,[],'FR');
 expect(b).toMatchObject({cvr:.1,reason:'Same page in benchmark market'});
 expect(b.reference).toBe(fr);
 expect(chooseBenchmark(fr,saved,[],'FR').cvr).toBeNull();
 expect(fr.dimensions.market).toBe('France');
 expect(de.dimensions.market).toBe('Germany');
});

it.each(['France','FR'])('retains the qualified review ranking with immutable older country-name evidence and a %s config',benchmarkMarket=>{
 const configured={...client,config:{...client.config,benchmarkMarket}},a=queryClient(configured,rows,[],filters),context=buildAIContext([{...a,note:{body:'',version:0},findings:[],reviews:[]}],filters),c=context.clients[0];
 const saved=c.datasetDetails.funnels.rows.map(r=>({...r,dimensions:{...r.dimensions,market:r.dimensions.market==='FR'?'France':'Germany'}}));
 c.datasetDetails.funnels.rows=saved;
 const before=JSON.stringify(saved),ranked=rankedReviewPages(c,filters);
 expect(ranked).toHaveLength(1);
 expect(ranked[0]).toMatchObject({market:'Germany',benchmark:.1,benchmarkReason:'Same page in benchmark market'});
 expect(ranked[0].gap).toBeCloseTo(50);
 expect(JSON.stringify(saved)).toBe(before);
 expect(c.client.config.benchmarkMarket).toBe(benchmarkMarket);
});
