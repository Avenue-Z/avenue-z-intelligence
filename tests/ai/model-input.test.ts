import {it,expect} from 'vitest';
import {buildAIContext,compactAIContextForModel,restoreAIContextSnapshot} from '../../lib/ai/context';
import {boundedAIContextForModel} from '../../lib/ai/model-input';
import {queryClient} from '../../lib/analytics/query';
import {evidenceDetailRows} from '../../lib/ai/evidence';
import clients from '../../data/initial-clients.json';

const client=clients[1] as any;
const filters={from:'2026-10-07',to:'2026-10-07',view:'overview',mode:'closed',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
function fixture(large=false){
 const base=queryClient(client,[],[],filters),context=buildAIContext([{...base,note:{body:'Scope note'},findings:[{id:'existing-issue',title:'Check offer',detail:'Existing dated diagnosis',status:'closed',owner:'Media',severity:'investigate'}],reviews:[]}] as any,filters);
 const c=context.clients[0];
 const datasets=large?['funnels','markets','media','products','discounts','subscriptions','traffic']:['funnels'];
 for(const dataset of datasets){
  const rows=Array.from({length:96},(_,i)=>({date:filters.to,dataset,metric:'sessions',value:i===95?0:96-i,dimensions:{page:`/landing-${i}`,market:'US',device:'mobile'},definition:'human_landing_sessions',population:'human_sessions',currency:null,sourceId:`source-${dataset}`,retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:null,quality:'partial'}));
  c.datasetDetails[dataset]=evidenceDetailRows(rows as any);
  if(large)c.comparisonDatasetDetails[dataset]=evidenceDetailRows(rows.map(r=>({...r,date:'2026-10-06',value:r.value+1})) as any);
 }
 c.subscriptions={current:{from:filters.from,to:filters.to,revenue:0,orders:0},comparison:{from:'2026-09-09',to:'2026-09-09',revenue:null,orders:null},contamination:{title:'Incident contamination',note:'Use the clean alternate'},elapsedDays:1} as any;
 c.incidents=[{id:'incident',title:'Measurement break',start:filters.to,metrics:['atc'],note:'Not comparable'}];
 if(large){c.notes='Large historical note '.repeat(6000);c.sourceReviews=[{sourceId:'review:fixed',storeDate:filters.to,revision:1,scopeLabel:'Fixed report',payload:{type:'historical',text:'Historical source prose '.repeat(9000)}}] as any;context.sources.push({id:'review:fixed',label:'Fixed report',url:'/clients/beam/reviews/fixed'});}
 return context;
}

it('bounds model input even when numeric previews and saved source prose exceed the provider budget',()=>{
 const context=fixture(true),projection=boundedAIContextForModel(context);
 expect(JSON.stringify(compactAIContextForModel(context)).length).toBeGreaterThan(300000);
 expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(280000);
 expect((projection as any).preview.collections.some((x:any)=>x.omittedRows>0)).toBe(true);
 expect((projection as any).preview.text.some((x:any)=>x.omittedCharacters>0)).toBe(true);
});

it('reports preview omissions against original segment and observation counts',()=>{
 const projection=boundedAIContextForModel(fixture()) as any,cut=projection.context.clients[0].datasetDetails.funnels;
 expect(cut).toMatchObject({segmentCount:96,returnedSegmentCount:16,omitted:80,observationCount:96,returnedObservationCount:16,omittedObservationCount:80});
 expect(projection.preview.collections.find((x:any)=>x.path==='clients[0].datasetDetails.funnels.rows')).toMatchObject({availableRows:80,includedRows:16,omittedRows:64,preexistingOmittedRows:16});
});

it('keeps exact citations, workflow IDs, qualification and dates while removing opaque row keys',()=>{
 const context=fixture(),before=JSON.stringify(context),projection=boundedAIContextForModel(context) as any,c=projection.context.clients[0];
 expect(JSON.stringify(context)).toBe(before);
 expect(c.findings).toEqual([{id:'existing-issue',title:'Check offer',detail:'Existing dated diagnosis',status:'closed',owner:'Media',severity:'investigate'}]);
 expect(projection.context.sources).toEqual(context.sources);expect(projection.context.filters).toEqual(filters);
 expect(c.subscriptions.current.revenue).toBe(0);expect(c.subscriptions.comparison.revenue).toBeNull();expect(c.subscriptions.contamination).toEqual(context.clients[0].subscriptions.contamination);
 expect(c.warnings).toEqual(context.clients[0].warnings);expect(c.spendVerdict).toEqual(context.clients[0].spendVerdict);expect(c.reportTiming).toEqual(context.clients[0].reportTiming);
 expect(Object.values(projection.evidenceRows).every((row:any)=>!('key' in row))).toBe(true);
 const scope=Object.fromEntries(projection.provenanceScopeColumns.map((key:string,i:number)=>{const cell=(Object.values(projection.provenanceScopes)[0] as any[])[i];return [key,typeof cell==='string'?projection.provenanceTextValues[cell]:cell];}));
 expect(scope).toMatchObject({date:filters.to,quality:'partial',coverageThrough:null,definition:'human_landing_sessions',withoutIntervalCount:1,intervalObservationCount:0});
 const saved=compactAIContextForModel(context);expect(saved.compression.numericRowsOmitted).toBe(0);expect(restoreAIContextSnapshot(JSON.parse(JSON.stringify(saved)))).toEqual(JSON.parse(before));
});

it('updates top-level detail previews and accounts for rows already omitted before the model projection',()=>{
 const rows=Array.from({length:150},(_,i)=>({date:filters.to,dataset:'funnels',metric:'sessions',value:150-i,dimensions:{page:`/page-${i}`,market:'US'},definition:'human',population:'human',currency:null,sourceId:'funnels',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:null,quality:'partial'}));
 const analytics=queryClient(client,[...rows,...rows.map(r=>({...r,date:'2026-10-06'}))] as any,[],filters),context=buildAIContext([{...analytics,note:{body:''},findings:[],reviews:[]}] as any,filters),projection=boundedAIContextForModel(context) as any,c=projection.context.clients[0];
 expect(c.details).toHaveLength(16);expect(c.comparisonDetails).toHaveLength(16);expect(c.detailsOmitted).toBe(134);expect(c.comparisonDetailsOmitted).toBe(134);
 expect(c.detailCounts).toMatchObject({segments:150,returned:16,observations:150,returnedObservations:16,omittedObservations:134});
 expect(c.comparisonDetailCounts).toMatchObject({segments:150,returned:16,observations:150,returnedObservations:16,omittedObservations:134});
 expect(projection.preview.collections.find((x:any)=>x.path==='clients[0].details')).toMatchObject({availableRows:120,includedRows:16,omittedRows:104,preexistingOmittedRows:30});
 expect(projection.preview.collections.find((x:any)=>x.path==='clients[0].comparisonDetails')).toMatchObject({availableRows:120,includedRows:16,omittedRows:104,preexistingOmittedRows:30});
});

it('fails closed when mandatory client and workflow identities cannot fit instead of silently dropping them',()=>{
 const context=fixture();context.clients[0].findings=Array.from({length:4000},(_,i)=>({id:`existing-${i}`,title:'An existing issue with an identity that must remain available to prevent duplicate follow-ups',detail:'Dated detail',status:'closed',owner:'Media',severity:'investigate'}));
 const before=JSON.stringify(context);expect(()=>boundedAIContextForModel(context)).toThrow(/narrower reporting scope/);expect(JSON.stringify(context)).toBe(before);
});

it('preserves numeric zero and labels sparse absent metrics as unavailable rather than zero',()=>{
 const context=fixture(),cut=context.clients[0].datasetDetails.funnels;
 cut.rows=[{...cut.rows[0],metrics:{sessions:0,orders:null},summary:{...cut.rows[0].summary,sessions:0},derived:{discountRate:null,atcToOrderClose:null}}];
 const projection=boundedAIContextForModel(context) as any,row=Object.values(projection.evidenceRows)[0] as any;
 expect(row.metrics).toEqual({sessions:0});expect(row.summary.sessions).toBe(0);expect(row.derived).toEqual({});
 expect(projection.instruction).toMatch(/absent.*unavailable/i);expect(projection.instruction).toMatch(/never zero/i);
});

it('retains a smaller numeric preview before dropping all dated detail when mandatory workflow identities consume the budget',()=>{
 const context=fixture(true);context.clients[0].findings=Array.from({length:1024},(_,i)=>({id:`existing-${i}`,title:'Preserve the exact identity of an existing conversion investigation so its subsequent evidence is matched to the shared workflow',detail:'Dated detail',status:'closed',owner:'Media',severity:'investigate'}));
 const projection=boundedAIContextForModel(context) as any;
 expect(projection.preview.rowLimit).toBe(2);expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(280000);
 expect(projection.context.clients[0].datasetDetails.products.rows).toHaveLength(2);
 expect(projection.context.clients[0].findings).toHaveLength(1024);
 expect(projection.instruction).toMatch(/omitted.*preview.*not.*unavailable/i);
});
