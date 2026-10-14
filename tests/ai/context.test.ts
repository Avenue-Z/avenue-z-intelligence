import {it,expect} from 'vitest';
import {buildAIContext,compactAIContextForModel,validateAnswer,STRATEGY_STANDARD} from '../../lib/ai/context';
import {queryClient} from '../../lib/analytics/query';
import clients from '../../data/initial-clients.json';
const filters={from:'2026-10-07',to:'2026-10-07',view:'funnels',mode:'closed',compare:'previous',market:'US',source:'facebook',page:'',stream:'',device:''} as const;
const client=clients[0] as any;
it('keeps the displayed operational comparison and its actual capture provenance in AI context',()=>{
 const r=queryClient(client,[],[],filters),comparison={baseline:{value:147803,asOf:'2026-10-13T21:20:30.259Z',retrievedAt:'2026-10-13T21:20:30.979Z',snapshotId:'verified-stock-snapshot'},delta:743,relativeChange:743/147803,alignment:'same-store-hour'};
 const ctx=buildAIContext([{...r,activeCustomerComparison:comparison,note:{body:''},findings:[],reviews:[]}] as any,filters);
 expect(ctx.clients[0]).toHaveProperty('activeCustomerComparison',comparison);
 expect(compactAIContextForModel(ctx).context.clients[0]).toHaveProperty('activeCustomerComparison',comparison);
});
it('binds analysis to server-filtered evidence and keeps other dates distinct',()=>{
 const r=queryClient(client,[],[],filters);const ctx=buildAIContext([{...r,note:{body:'Scope note'},findings:[],reviews:[{id:'rev',storeDate:'2026-10-06',revision:1,payload:{text:'Old evidence'},createdAt:'now'}]}] as any,filters,'rev');
 expect(ctx.filters).toEqual(filters);expect(ctx.clients[0].selectedReview?.storeDate).toBe('2026-10-06');expect(ctx.clients[0].warnings.join(' ')).toContain('No source observations');expect(ctx.clients[0]).not.toHaveProperty('connections');
});
it('does not attach invented citations',()=>{
 expect(()=>validateAnswer({answer:'Claim',sourceIds:['invented'],followUps:[],caveats:[]},[{id:'real',label:'report',url:'/report'}])).toThrow('citation');
});
it('includes the saved report KPI tiles separately from current queried metrics',()=>{const r=queryClient(client,[],[],filters),ctx=buildAIContext([{...r,note:{body:''},findings:[],reviews:[{id:'ai',current:true,storeDate:filters.to,revision:2,payload:{type:'ai',kpis:[{label:'Reported sales',value:'$37.5k',note:'Historical source'}]}}]}] as any,filters,'ai');expect(ctx.clients[0].sourceReviews[0].payload.kpis).toEqual([{label:'Reported sales',value:'$37.5k',note:'Historical source'}]);expect(ctx.clients[0].sourceReviews[0].scopeLabel).toContain('Fixed saved report');expect(ctx.clients[0].metrics.revenue).toBeNull();});
it('requires spend efficiency, contaminated recurring comparisons and no checkout diagnosis from CVR alone',()=>{expect(STRATEGY_STANDARD).toMatch(/spend.*revenue/i);expect(STRATEGY_STANDARD).toMatch(/four weeks/i);expect(STRATEGY_STANDARD).toMatch(/CVR.*checkout/i);});
it('supplies exact comparison arithmetic without upgrading historical data to qualified efficiency',()=>{const r=queryClient(client,[],[],filters),ctx=buildAIContext([{...r,metrics:{...r.metrics,revenue:138933.70,spend:24030.21},prior:{...r.prior,revenue:120459.95,spend:21068.10},note:{body:''},findings:[],reviews:[]}] as any,filters);const a=ctx.clients[0].comparisonArithmetic;expect(a.revenueChange).toBeCloseTo(.153359,5);expect(a.spendChange).toBeCloseTo(.1406,4);expect(a.spendPace).toBe('slower');expect(a.merDirection).toBe('up');expect(a.qualification).toContain('not establish');expect(ctx.clients[0].spendVerdict.spendComparison).toBe('unavailable');});
it('interns repeated numeric rows and exact provenance once without losing scope references or warnings',()=>{
 const f={...filters,market:'',source:'',view:'overview'},base=queryClient(client,[],[],f);
 const observation={date:f.to,dataset:'media',metric:'spend',value:17,dimensions:{channel:'meta'},definition:'store_day_spend',population:'paid_media',currency:client.currency,sourceId:'media-source',retrievedAt:'2026-10-08T08:00:00Z',coverageThrough:null,quality:'partial'} as const;
 const input=buildAIContext([{...base,evidence:[observation],selectedCount:1,warnings:['Coverage is unknown; do not infer efficiency'],note:{body:''},findings:[],reviews:[]}] as any,f),before=JSON.stringify(input),compact=compactAIContextForModel(input);
 expect(JSON.stringify(input)).toBe(before);expect(compact.compression.numericRowsOmitted).toBe(0);expect(compact.compression.evidenceRowReferences).toBeGreaterThan(compact.compression.uniqueEvidenceRows);
 expect(compact.compression.uniqueEvidenceRows).toBe(1);expect(Object.values(compact.evidenceRows)[0]).toMatchObject({dimensions:{channel:'meta'},metrics:{spend:17},summary:{spend:17}});
 const scope=Object.values(compact.provenanceScopes)[0];expect(scope).toMatchObject({date:f.to,sourceId:'media-source',definition:'store_day_spend',population:'paid_media',currency:client.currency,coverageThrough:null,quality:'partial',observationCount:1,withoutIntervalCount:1});
 expect(compact.context.filters).toEqual(f);expect(compact.context.clients[0].warnings).toEqual(input.clients[0].warnings);
 const rowReference=compact.context.clients[0].datasetDetails.media.rows[0] as any;expect(compact.evidenceRows[rowReference.evidenceRowId].metrics.spend).toBe(17);
 const provenanceId=compact.evidenceRows[rowReference.evidenceRowId].provenanceScopeIds[0];expect(compact.provenanceScopes[provenanceId].coverageThrough).toBeNull();
 expect(JSON.stringify(compact).length).toBeLessThan(before.length);
});
it('preserves every selected numeric row and explicit top-row omissions in the compact model context',()=>{
 const f={...filters,market:'',source:'',view:'funnels'},observations=Array.from({length:90},(_,i)=>({date:f.to,dataset:'funnels',metric:'sessions',value:i+1,dimensions:{page:`/page-${i}`,market:'US'},definition:'human_landing_sessions',population:'human_sessions',currency:null,sourceId:'shopify-funnels',retrievedAt:'2026-10-08T08:00:00Z',coverageThrough:'2026-10-08T08:00:00Z',quality:'complete'}));
 const a=queryClient(client,observations as any,[],f),context=buildAIContext([{...a,note:{body:''},findings:[],reviews:[]}] as any,f),compact=compactAIContextForModel(context),detail=compact.context.clients[0].datasetDetails.funnels;
 expect(detail).toMatchObject({segmentCount:90,returnedSegmentCount:80,omitted:10,observationCount:90,returnedObservationCount:80,omittedObservationCount:10});
 expect(compact.compression.uniqueEvidenceRows).toBe(90);expect(compact.compression.numericRowsOmitted).toBe(0);
 for(const [i,reference] of detail.rows.entries()){const row=compact.evidenceRows[reference.evidenceRowId];expect(row.dimensions).toEqual(context.clients[0].datasetDetails.funnels.rows[i].dimensions);expect(row.metrics).toEqual(context.clients[0].datasetDetails.funnels.rows[i].metrics);expect(row.summary).toEqual(context.clients[0].datasetDetails.funnels.rows[i].summary);}
 expect(compact.context.clients[0].warnings).toEqual(context.clients[0].warnings);
});
it('bounds a seven-day hourly channel fixture by sharing rows and source scopes rather than dropping evidence',()=>{
 const f={...filters,from:'2026-10-01',market:'',source:'',view:'media'},rows=[];
 for(let day=1;day<=7;day++)for(const channel of ['meta','applovin'])for(let hour=0;hour<24;hour++){
  const date=`2026-10-${String(day).padStart(2,'0')}`,start=new Date(`${date}T00:00:00Z`);start.setUTCHours(hour);const end=new Date(start.getTime()+3600000);
  rows.push({date,dataset:'media',metric:'spend',value:hour+1,dimensions:{channel},definition:'store_hour_paid_spend',population:'paid_media',currency:client.currency,sourceId:'hourly-media',retrievedAt:'2026-10-08T08:00:00Z',coverageThrough:'2026-10-08T08:00:00Z',quality:'complete',start:start.toISOString(),end:end.toISOString()});
 }
 const a=queryClient(client,rows as any,[],f),context=buildAIContext([{...a,note:{body:''},findings:[],reviews:[]}] as any,f),compact=compactAIContextForModel(context);
 expect(compact.compression.uniqueEvidenceRows).toBe(2);expect(Object.values(compact.evidenceRows).every(r=>r.metrics.spend===2100)).toBe(true);expect(compact.compression.uniqueProvenanceScopes).toBe(7);
 expect(Object.values(compact.provenanceScopes).reduce((sum,p)=>sum+p.observationCount,0)).toBe(168); // Scopes are shared across the two equal channel histories.
 expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(context).length*.65);
});
