import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({store:null as any,permitted:['a']}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({requireClientAccess:async()=>({organizationId:'o',permittedClientIds:state.permitted,role:'admin'}),getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
import {loadWorkspace,workspaceSearchParams,parseFilters} from '../../lib/server/workspace';
it('preserves shared URL scope for the initial server render',()=>{const p=workspaceSearchParams({from:'2026-09-10',to:'2026-10-08',view:'reviews',section:['findings','portfolio']});expect(p.get('from')).toBe('2026-09-10');expect(p.get('to')).toBe('2026-10-08');expect(p.get('section')).toBe('findings');});
it('resolves an old archive date before loading its detail tables',async()=>{
 const client={id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}};
 const date='2026-01-03',row={date,dataset:'overview',metric:'revenue',value:100,currency:'USD',definition:'web',population:'web',quality:'historical',dimensions:{},retrievedAt:'old'};
 state.store={first:async()=>null,clients:async()=>[client],connections:async()=>[],observations:async(_o:string,_c:string,f:any,headlineOnly:boolean)=>headlineOnly?[row]:f.from===date?[row,{...row,dataset:'funnels',metric:'sessions',value:10,dimensions:{page:'/lp'}}]:[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({clientId:'a'}));expect(result.filters.to).toBe(date);expect(result.clients[0].details).toHaveLength(1);
});

it("canonicalizes legacy country URL filters before rendering the dropdown",()=>{expect(parseFilters(new URLSearchParams()).market).toBe("");expect(parseFilters(new URLSearchParams({market:"France"})).market).toBe("FR");expect(parseFilters(new URLSearchParams({market:"United Kingdom"})).market).toBe("UK");expect(parseFilters(new URLSearchParams({market:"Atlantis"})).market).toBe("Atlantis");});
it('loads focused revenue datasets and only headline observations for the other authorized client',async()=>{
 state.permitted=['a','b'];const reads:{clientId:string;datasets:string[]|undefined}[]=[],clients=['a','b'].map(id=>({id,name:id,timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}));
 state.store={first:async()=>null,clients:async()=>clients,connections:async()=>[],observations:async(_o:string,clientId:string,_f:any,_headlines:boolean,_options:any,selection:any)=>{reads.push({clientId,datasets:selection?.datasets});return ['overview','revenue','products'].filter(dataset=>!selection||selection.datasets.includes(dataset)).map(dataset=>({date:'2026-10-07',dataset,metric:'revenue',value:clientId==='a'?100:800,currency:'USD',definition:'web',population:'web',quality:'complete',dimensions:{},retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',sourceId:'source'}));},findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({clientId:'a',view:'revenue',from:'2026-10-07',to:'2026-10-07'}));expect(result).toHaveProperty('focusedClientId','a');expect(reads).toEqual([{clientId:'a',datasets:['overview','revenue','subscriptions','subscriptionEvents','orderStreams','orderHygiene']},{clientId:'b',datasets:['overview']}]);expect(result.clients[0].datasetSeries.revenue[0].summary.revenue).toBe(100);expect(result.clients[0].views.products).toBeUndefined();expect(result.clients[1].metrics.revenue).toBe(800);expect(result.clients[1].views.revenue).toBeUndefined();state.permitted=['a'];
});
it('rejects an unavailable focused client before loading observations',async()=>{state.permitted=['a'];await expect(loadWorkspace(new URLSearchParams({clientId:'outside'}))).rejects.toThrow('Client');});
it('loads lightweight review indexes for analytics and full documents for both client and portfolio archives',async()=>{
 const review={id:'r',clientId:'a',storeDate:'2026-10-07',createdAt:'2026-10-08T00:00:00Z',revision:1,current:true,payload:{type:'ai',summary:'Dated summary',actions:[{title:'Review budgets'}],sources:[{id:'s',url:'/evidence'}],sections:[{title:'Numeric appendix',text:'Complete report'}]}};
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[],observations:async()=>[],findings:async()=>[],reviews:async()=>[review],note:async()=>({body:''}),jobs:async()=>[]};
 const dates={from:'2026-10-07',to:'2026-10-07'},analytics=await loadWorkspace(new URLSearchParams({...dates,clientId:'a',view:'revenue'}));
 expect(analytics.clients[0].reviewsIndexOnly).toBe(true);expect(analytics.clients[0].reviews[0].payload.sections).toBeUndefined();expect(analytics.clients[0].reviews[0].payload.actions).toEqual(review.payload.actions);
 const clientArchive=await loadWorkspace(new URLSearchParams({...dates,clientId:'a',view:'reviews'}));expect(clientArchive.clients[0].reviewsIndexOnly).toBe(false);expect(clientArchive.clients[0].reviews[0].payload.sections).toEqual(review.payload.sections);
 const portfolioArchive=await loadWorkspace(new URLSearchParams({...dates,section:'reviews',view:'overview'}));expect(portfolioArchive.clients[0].reviewsIndexOnly).toBe(false);expect(portfolioArchive.clients[0].reviews[0].payload.sections).toEqual(review.payload.sections);
});
it('keeps an unfocused portfolio to headline and renewal datasets without advertising client tabs',async()=>{
 const reads:string[][]=[];state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[],observations:async(_o:any,_c:any,_f:any,_h:any,_b:any,selection:any)=>{reads.push(selection.datasets);return [];},findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({from:'2026-10-07',to:'2026-10-07'}));expect(reads).toEqual([['overview','subscriptions','subscriptionEvents']]);expect(result.clients[0].views.products).toBeUndefined();expect(result.clients[0].preparedDatasets).toEqual(['overview','subscriptions','subscriptionEvents']);
});

it('narrows dimensions only for an authorized focused Traffic page drill',async()=>{
 state.permitted=['a','b'];const reads:{client:string;dimensions:boolean;datasets:string[];trendDatasets:string[]}[]=[];
 const operations={first:vi.fn(async()=>null),findings:vi.fn(async()=>[]),reviews:vi.fn(async()=>[]),note:vi.fn(async()=>({body:''})),jobs:vi.fn(async()=>[])};
 state.store={...operations,clients:async()=>['a','b'].map(id=>({id,name:id,timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}})),connections:async()=>[],observations:async(_o:any,client:string,_f:any,_h:any,_b:any,selection:any)=>{reads.push({client,dimensions:!!selection.dimensions,datasets:selection.datasets,trendDatasets:selection.trendDatasets});return [];}};
 const params=new URLSearchParams({clientId:'a',view:'traffic',from:'2026-10-10',to:'2026-10-11',page:'/selected'});
 await loadWorkspace(params);expect(reads.map(({client,dimensions})=>({client,dimensions}))).toEqual([{client:'a',dimensions:false},{client:'b',dimensions:false}]);expect(reads[0].trendDatasets).toContain('traffic');reads.length=0;
 for(const operation of Object.values(operations)){expect(operation).toHaveBeenCalled();operation.mockClear();}
 params.set('drill','traffic-page');const detail=await loadWorkspace(params);expect(reads).toEqual([{client:'a',dimensions:true,datasets:['traffic','funnels'],trendDatasets:[]}]);expect(detail.clients.map(client=>client.client.id)).toEqual(['a']);expect(detail.filters).toMatchObject({from:'2026-10-10',to:'2026-10-11',page:'/selected',view:'traffic'});for(const operation of Object.values(operations))expect(operation).not.toHaveBeenCalled();state.permitted=['a'];
});
it('defaults a focused live client to today in its store timezone and preserves explicit closed history',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T22:30:00Z'));try{
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'Europe/Stockholm',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[{id:'source',enabled:true}],observations:async()=>[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 expect((await loadWorkspace(new URLSearchParams({clientId:'a'}))).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',mode:'partial',period:'today'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',mode:'closed'}))).filters).toMatchObject({from:'2026-10-12',to:'2026-10-12',mode:'closed'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',mode:'partial'}))).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',period:'today'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',from:'2026-10-09',to:'2026-10-10'}))).filters).toMatchObject({from:'2026-10-09',to:'2026-10-10'});
 }finally{vi.useRealTimers();}
});
it('rolls an explicit live-today marker across store midnight while keeping a chosen historical date fixed',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T22:30:00Z'));try{
  state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'Europe/Stockholm',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[{id:'source',enabled:true}],observations:async()=>[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
  expect((await loadWorkspace(new URLSearchParams({clientId:'a',period:'today',from:'2026-10-13',to:'2026-10-13',view:'products'}))).filters).toMatchObject({from:'2026-10-14',to:'2026-10-14',mode:'partial',view:'products',period:'today'});
  expect((await loadWorkspace(new URLSearchParams({clientId:'a',from:'2026-10-13',to:'2026-10-13',view:'products'}))).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',mode:'closed',view:'products'});
 }finally{vi.useRealTimers();}
});

it('defaults live and historical analytics to the previous period while retaining an explicit comparison',()=>{
 expect(parseFilters(new URLSearchParams()).compare).toBe('previous');
 expect(parseFilters(new URLSearchParams({from:'2026-10-12',to:'2026-10-12'})).compare).toBe('previous');
 expect(parseFilters(new URLSearchParams({compare:'weekday'})).compare).toBe('weekday');
});
it('keeps the live URL and displayed date on its captured store day until the first complete next-day hour',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T22:30:00Z'));try{
  state.permitted=['a'];const readFilters:any[]=[],client={id:'a',name:'A',timezone:'Europe/Stockholm',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}};
  const source={id:'sales',provider:'kind-shopify-sales',enabled:true,coverageThrough:'2026-10-13T21:00:00Z'};
  state.store={first:async()=>null,clients:async()=>[client],connections:async()=>[source],observations:async(_o:any,_c:any,f:any)=>{readFilters.push(f);return [];},findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
  const live=new URLSearchParams({clientId:'a',period:'today',from:'2026-10-14',to:'2026-10-14',view:'revenue'});
  expect((await loadWorkspace(live)).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',period:'today',mode:'partial'});
  expect(readFilters.at(-1)).toMatchObject({from:'2026-10-13',to:'2026-10-13'});
  const explicit=new URLSearchParams({clientId:'a',from:'2026-10-14',to:'2026-10-14',view:'revenue',mode:'partial'});
  expect((await loadWorkspace(explicit)).filters).toMatchObject({from:'2026-10-14',to:'2026-10-14'});
  source.coverageThrough='2026-10-13T23:00:00Z';vi.setSystemTime(new Date('2026-10-13T23:05:00Z'));
  expect((await loadWorkspace(live)).filters).toMatchObject({from:'2026-10-14',to:'2026-10-14',period:'today'});
 }finally{vi.useRealTimers();}
});
