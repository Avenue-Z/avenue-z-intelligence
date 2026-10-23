import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({store:null as any,permitted:['a']}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({requireClientAccess:async()=>({organizationId:'o',permittedClientIds:state.permitted,role:'admin'}),getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
import {loadWorkspace,workspaceSearchParams,parseFilters} from '../../lib/server/workspace';
import {buildAlertQueue} from '../../lib/analytics/alerts';
import type {Store} from '../../lib/server/store';
import type {Client,Observation} from '../../lib/analytics/contracts';
import initialClients from '../../data/initial-clients.json';
it('preserves shared URL scope for the initial server render',()=>{const p=workspaceSearchParams({from:'2026-09-10',to:'2026-10-08',view:'reviews',section:['findings','portfolio']});expect(p.get('from')).toBe('2026-09-10');expect(p.get('to')).toBe('2026-10-08');expect(p.get('section')).toBe('findings');});
it('resolves an old archive date before loading its detail tables',async()=>{
 const client={id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}};
 const date='2026-01-03',row={date,dataset:'overview',metric:'revenue',value:100,currency:'USD',definition:'web',population:'web',quality:'historical',dimensions:{},retrievedAt:'old'};
 state.store={first:async()=>null,clients:async()=>[client],connections:async()=>[],observations:async(_o:string,_c:string,f:any,headlineOnly:boolean)=>headlineOnly?[row]:f.from===date?[row,{...row,dataset:'funnels',metric:'sessions',value:10,dimensions:{page:'/lp'}}]:[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({clientId:'a'}));expect(result.filters.to).toBe(date);expect(result.clients[0].details).toHaveLength(1);
});

it("canonicalizes legacy country URL filters before rendering the dropdown",()=>{expect(parseFilters(new URLSearchParams()).market).toBe("");expect(parseFilters(new URLSearchParams({market:"France"})).market).toBe("FR");expect(parseFilters(new URLSearchParams({market:"United Kingdom"})).market).toBe("UK");expect(parseFilters(new URLSearchParams({market:"Atlantis"})).market).toBe("Atlantis");});
it('loads only focused revenue analytics while retaining the other authorized client in navigation metadata',async()=>{
 state.permitted=['a','b'];const reads:{clientId:string;datasets:string[]|undefined}[]=[],clients=['a','b'].map(id=>({id,name:id,timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}));
 state.store={first:async()=>null,clients:async()=>clients,connections:async()=>[],observations:async(_o:string,clientId:string,_f:any,_headlines:boolean,_options:any,selection:any)=>{reads.push({clientId,datasets:selection?.datasets});return ['overview','revenue','products'].filter(dataset=>!selection||selection.datasets.includes(dataset)).map(dataset=>({date:'2026-10-07',dataset,metric:'revenue',value:clientId==='a'?100:800,currency:'USD',definition:'web',population:'web',quality:'complete',dimensions:{},retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',sourceId:'source'}));},findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({clientId:'a',view:'revenue',from:'2026-10-07',to:'2026-10-07'}));expect(result).toHaveProperty('focusedClientId','a');expect(reads).toEqual([{clientId:'a',datasets:['overview','revenue','subscriptions','subscriptionEvents','orderStreams','orderHygiene'] }]);expect(result.clients[0].datasetSeries.revenue[0].summary.revenue).toBe(100);expect(result.clients[0].views.products).toBeUndefined();expect(result.clients.map(record=>record.client.id)).toEqual(['a']);expect(result.navigationClients?.map(client=>client.id)).toEqual(['a','b']);state.permitted=['a'];
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
it('bounds only portfolio review indexes to the latest current review and latest current AI review',async()=>{
 const review=(id:string,storeDate:string,type:string,current=true)=>({id,clientId:'a',storeDate,createdAt:`${storeDate}T12:00:00Z`,revision:1,current,payload:{type,actions:[{title:id}],sections:[{title:'Full archive document'}]}}),reviews=[review('old-ai','2026-10-12','ai'),review('latest-ai','2026-10-14','ai'),review('superseded','2026-10-16','ai',false),review('latest-current','2026-10-15','computed')];
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[],observations:async()=>[],findings:async()=>[],reviews:async()=>reviews,note:async()=>({body:''}),jobs:async()=>[]};
 const dates={from:'2026-10-15',to:'2026-10-15'},portfolio=await loadWorkspace(new URLSearchParams({...dates,section:'portfolio'}));expect(portfolio.clients[0].reviews.map(item=>item.id)).toEqual(['latest-current','latest-ai']);expect(portfolio.clients[0].reviews.every(item=>item.payload.sections===undefined)).toBe(true);expect(portfolio.clients[0].reviews[1].payload.actions).toEqual([{title:'latest-ai'}]);
 const archive=await loadWorkspace(new URLSearchParams({...dates,section:'reviews'}));expect(archive.clients[0].reviews).toHaveLength(4);expect(archive.clients[0].reviews.every(item=>Array.isArray(item.payload.sections))).toBe(true);
 const findings=await loadWorkspace(new URLSearchParams({...dates,section:'findings'}));expect(findings.clients[0].reviews).toHaveLength(4);
 const focused=await loadWorkspace(new URLSearchParams({...dates,clientId:'a',section:'portfolio'}));expect(focused.clients[0].reviews).toHaveLength(4);
 reviews.push(review('newest-ai','2026-10-17','ai'));const deduped=await loadWorkspace(new URLSearchParams({...dates,section:'portfolio'}));expect(deduped.clients[0].reviews.map(item=>item.id)).toEqual(['newest-ai']);expect(reviews).toHaveLength(5);
});
it('keeps an unfocused portfolio to headline datasets without advertising client tabs',async()=>{
 const reads:string[][]=[];state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[],observations:async(_o:any,_c:any,_f:any,_h:any,_b:any,selection:any)=>{reads.push(selection.datasets);return [];},findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({from:'2026-10-07',to:'2026-10-07'}));expect(reads).toEqual([['overview','funnels']]);expect(result.clients[0].views.products).toBeUndefined();expect(result.clients[0].preparedDatasets).toEqual(['overview','funnels']);
});
it('ignores a stale Traffic drill on the portfolio while retaining its light data and workflow metadata',async()=>{
 const observations=vi.fn<Store['observations']>(async()=>[]),jobs=vi.fn(async()=>[]),reviews=vi.fn(async()=>[]),findings=vi.fn(async()=>[]);
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[],observations,findings,reviews,note:async()=>({body:''}),jobs};
 const result=await loadWorkspace(new URLSearchParams({section:'portfolio',drill:'traffic-page',view:'traffic',page:'/old-page',from:'2026-10-15',to:'2026-10-15'}));expect(result.filters).toMatchObject({view:'overview',page:''});expect(observations.mock.calls).toHaveLength(1);expect(observations.mock.calls[0][5]?.datasets).toEqual(['overview','funnels']);expect(jobs).toHaveBeenCalledTimes(1);expect(reviews).toHaveBeenCalledTimes(1);expect(findings).toHaveBeenCalledTimes(1);
 await expect(loadWorkspace(new URLSearchParams({section:'findings',drill:'traffic-page',view:'traffic',page:'/old-page',from:'2026-10-15',to:'2026-10-15'}))).rejects.toThrow('Invalid workspace drill');
 await expect(loadWorkspace(new URLSearchParams({section:'portfolio',drill:'other',from:'2026-10-15',to:'2026-10-15'}))).rejects.toThrow('Invalid workspace drill');
});
it.each([undefined,'portfolio'])('canonicalizes portfolio section %s without changing the selected dates or comparison and loads only permitted Beam report metadata',async section=>{
 const clients=initialClients.filter(client=>client.id==='kind-patches'||client.id==='beam').map(client=>({...client,id:client.id==='kind-patches'?'a':client.id,version:1})) as Client[],media:Observation={date:'2026-10-07',dataset:'media',metric:'platform_spend',value:123,definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',currency:'USD',dimensions:{channel:'meta',provider_as_of:'2026-10-08T05:00:00Z',reporting_timezone:'provider_account_timezone_unverified'},sourceId:'beam-motion',retrievedAt:'2026-10-08T05:05:00Z',coverageThrough:null,quality:'complete'};
 const observations=vi.fn<Store['observations']>(async(_org,client,_filters,_headline,_options,selection)=>client==='beam'&&selection?.datasets.includes('media')?[media]:[]);
 state.permitted=['a','beam'];state.store={first:async()=>null,clients:async()=>clients,connections:async()=>[],observations,findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const params=new URLSearchParams({from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'custom',compareFrom:'2026-09-30',compareTo:'2026-09-30',view:'products',market:'US',source:'facebook',stream:'Online Store',device:'mobile',page:'/old-page',...section?{section}:{}}),result=await loadWorkspace(params);
 expect(result.filters).toMatchObject({from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'custom',compareFrom:'2026-09-30',compareTo:'2026-09-30',view:'overview',market:'',source:'',stream:'',device:'',page:''});expect(params.get('page')).toBe('/old-page');
 expect(observations.mock.calls).toHaveLength(3);expect(observations.mock.calls.map(call=>({client:call[1],datasets:call[5]?.datasets}))).toEqual(expect.arrayContaining([{client:'a',datasets:['overview','funnels']},{client:'beam',datasets:['overview','funnels','media']},{client:'beam',datasets:['media']}]));
 for(const call of observations.mock.calls)expect(call[2]).toMatchObject(result.filters);
 const metadataRead=observations.mock.calls.find(call=>call[5]?.datasets.join(',')==='media');expect(metadataRead?.[5]).toEqual({datasets:['media'],includeOperations:false,includePriorWeek:false,trendDatasets:['media']});
 const beam=result.clients.find(record=>record.client.id==='beam')!,ordinary=result.clients.find(record=>record.client.id==='a')!;expect(beam.resolvedFilters).toEqual(result.filters);expect(beam.portfolioMediaReports).toEqual([{date:media.date,spend:123,currency:'USD',asOf:media.dimensions.provider_as_of,timezone:media.dimensions.reporting_timezone,quality:'complete',sourceId:media.sourceId}]);expect(ordinary.portfolioMediaReports).toBeUndefined();
 observations.mockClear();state.permitted=['a'];const restricted=await loadWorkspace(params);expect(restricted.clients.map(record=>record.client.id)).toEqual(['a']);expect(observations.mock.calls.every(call=>call[1]==='a')).toBe(true);
});
it('returns each brand live store date in resolvedFilters while retaining the shared portfolio date marker',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-16T23:30:00Z'));try{
 const clients=initialClients.filter(client=>client.id==='kind-patches'||client.id==='beam').map(client=>({...client,id:client.id==='kind-patches'?'a':client.id,version:1})) as Client[],observations=vi.fn<Store['observations']>(async()=>[]);
 state.permitted=['a','beam'];state.store={first:async()=>null,clients:async()=>clients,connections:async(_org:string,id:string)=>[{id:`${id}-sales`,provider:id==='beam'?'beam-shopify-sales':'kind-triple-whale',enabled:true,coverageThrough:id==='beam'?'2026-10-16T21:00:00Z':'2026-10-16T23:00:00Z'}],observations,findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({period:'today',view:'products',market:'US'}));expect(result.filters).toMatchObject({from:'2026-10-16',to:'2026-10-16',period:'today',view:'overview',market:''});
 expect(result.clients.find(record=>record.client.id==='a')?.resolvedFilters).toMatchObject({from:'2026-10-17',to:'2026-10-17',period:'today',view:'overview'});expect(result.clients.find(record=>record.client.id==='beam')?.resolvedFilters).toMatchObject({from:'2026-10-16',to:'2026-10-16',period:'today',view:'overview'});
 }finally{vi.useRealTimers();state.permitted=['a'];}
});

it('loads only matched-period page evidence for global business alerts and preserves tracked ownership',async()=>{
 state.permitted=['a'];const reads:{clientId:string;filters:any;selection:any}[]=[];
 const tracked={id:'assigned',clientId:'a',title:'Subscription follow-up',detail:'Review the cancellation cohort',severity:'investigate',status:'investigating',owner:'Retention lead',evidence:['https://claude.ai/artifact/original'],version:2,updatedAt:'2026-10-06T12:00:00Z'};
 const observations=['2026-10-06','2026-10-07'].flatMap(date=>[0,1,2,3].flatMap(hour=>['sessions','converting_sessions'].map(metric=>({date,dataset:'funnels',metric,value:metric==='sessions'?1000:date==='2026-10-06'?30:hour===3?900:10,dimensions:{page:'/lp',market:'US'},definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,sourceId:'source',retrievedAt:'2026-10-07T03:00:00Z',coverageThrough:'2026-10-07T03:00:00Z',quality:'complete',start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`}))));
 state.store={first:async()=>null,clients:async()=>['a','outside'].map(id=>({id,name:id,timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}})),connections:async()=>[{id:'source',provider:'gateway',enabled:true,coverageThrough:'2026-10-07T03:00:00Z'}],observations:async(_o:string,clientId:string,f:any,_h:boolean,_o2:any,selection:any)=>{reads.push({clientId,filters:f,selection});return observations.filter(row=>selection.datasets.includes(row.dataset));},findings:async()=>[tracked],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams({section:'findings',view:'subscriptions',from:'2026-10-07',to:'2026-10-07',mode:'partial',market:'US'}));
 expect(reads).toHaveLength(1);expect(reads[0].clientId).toBe('a');expect(reads[0].selection).toEqual({datasets:['overview','subscriptions','subscriptionEvents','funnels'],includePriorWeek:false,includeOperations:false,trendDatasets:[]});
 expect(reads[0].filters).toMatchObject({from:'2026-10-07',to:'2026-10-07',compare:'previous',mode:'partial',market:'US',view:'subscriptions'});
 const queue=buildAlertQueue(result.clients,result.filters),conversion=queue.find(alert=>alert.category==='Conversion opportunity');
 expect(conversion?.figures).toEqual([{label:'Sessions',current:3000,previous:null,format:'number'},{label:'Conversion rate',current:.01,previous:.03,format:'percent'}]);
 expect(conversion?.period).toMatchObject({from:'2026-10-07',to:'2026-10-07',market:'US',mode:'partial'});
 expect(queue.find(alert=>alert.key==='assigned')).toMatchObject({owner:'Retention lead',status:'investigating',finding:tracked});
 expect(tracked).toMatchObject({owner:'Retention lead',status:'investigating',version:2});
});

it('narrows dimensions only for an authorized focused Traffic page drill',async()=>{
 state.permitted=['a','b'];const reads:{client:string;dimensions:boolean;datasets:string[];trendDatasets:string[]}[]=[];
 const operations={first:vi.fn(async()=>null),findings:vi.fn(async()=>[]),reviews:vi.fn(async()=>[]),note:vi.fn(async()=>({body:''})),jobs:vi.fn(async()=>[])};
 state.store={...operations,clients:async()=>['a','b'].map(id=>({id,name:id,timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}})),connections:async()=>[],observations:async(_o:any,client:string,_f:any,_h:any,_b:any,selection:any)=>{reads.push({client,dimensions:!!selection.dimensions,datasets:selection.datasets,trendDatasets:selection.trendDatasets});return [];}};
 const params=new URLSearchParams({clientId:'a',view:'traffic',from:'2026-10-10',to:'2026-10-11',page:'/selected'});
 await loadWorkspace(params);expect(reads.map(({client,dimensions})=>({client,dimensions}))).toEqual([{client:'a',dimensions:false}]);expect(reads[0].trendDatasets).toContain('traffic');reads.length=0;
 for(const operation of Object.values(operations)){expect(operation).toHaveBeenCalled();operation.mockClear();}
 params.set('drill','traffic-page');const detail=await loadWorkspace(params);expect(reads).toEqual([{client:'a',dimensions:true,datasets:['traffic','funnels'],trendDatasets:[]}]);expect(detail.clients.map(client=>client.client.id)).toEqual(['a']);expect(detail.filters).toMatchObject({from:'2026-10-10',to:'2026-10-11',page:'/selected',view:'traffic'});for(const operation of Object.values(operations))expect(operation).not.toHaveBeenCalled();state.permitted=['a'];
});
it('defaults a focused live client to today in its store timezone and preserves explicit closed history',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-12T22:30:00Z'));try{
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{id:'a',name:'A',timezone:'Europe/Stockholm',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}}],connections:async()=>[{id:'source',enabled:true}],observations:async()=>[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 expect((await loadWorkspace(new URLSearchParams({clientId:'a'}))).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',mode:'partial',period:'today'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',mode:'closed'}))).filters).toMatchObject({from:'2026-10-12',to:'2026-10-12',mode:'closed'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',mode:'partial'}))).filters).toMatchObject({from:'2026-10-13',to:'2026-10-13',period:'today'});
 expect((await loadWorkspace(new URLSearchParams({clientId:'a',from:'2026-10-09',to:'2026-10-10'}))).filters).toMatchObject({from:'2026-10-09',to:'2026-10-10'});
 }finally{vi.useRealTimers();}
});
it('rolls an explicit live-today marker across store midnight while keeping a chosen historical date fixed',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T22:30:00Z'));try{
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
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T22:30:00Z'));try{
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

it('keeps all six qualified page alerts alongside seven tracked priorities in portfolio and findings with the same dates',async()=>{
 const client={...initialClients[0],id:'a',timezone:'UTC',version:1,config:{...initialClients[0].config,minSessions:100,minOpportunity:5,maxActions:6}},rows:Observation[]=['2026-10-06','2026-10-07'].flatMap(date=>Array.from({length:6},(_,page)=>['sessions','converting_sessions'].map(metric=>({date,dataset:'funnels',metric,value:metric==='sessions'?1000:date==='2026-10-07'?10:30,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:`/page-${page}`,market:'US'},sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete' as const}))).flat());
 const findings=Array.from({length:7},(_,index)=>({id:`finding-${index}`,clientId:'a',title:`Tracked ${index}`,detail:'Existing business priority',severity:'watch',status:'open',owner:'',evidence:[]}));
 const observations=vi.fn<Store['observations']>(async(_org,_client,_filters,_headlines,_options,selection)=>rows.filter(row=>selection?.datasets.includes(row.dataset)));
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[client],connections:async()=>[],observations,findings:async()=>findings,reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const params={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview'},portfolio=await loadWorkspace(new URLSearchParams({...params,section:'portfolio'})),global=await loadWorkspace(new URLSearchParams({...params,section:'findings'}));
 const portfolioQueue=buildAlertQueue(portfolio.clients,portfolio.filters),findingsQueue=buildAlertQueue(global.clients,global.filters);
 expect(portfolio.clients[0].qualifiedPageAlerts).toHaveLength(6);expect(portfolioQueue).toHaveLength(13);expect(findingsQueue).toHaveLength(13);expect(portfolioQueue.map(alert=>alert.key).sort()).toEqual(findingsQueue.map(alert=>alert.key).sort());
 expect(portfolio.clients[0].details).toEqual([]);expect(portfolio.clients[0].trafficExplorer).toBeUndefined();expect(portfolio.clients[0].comparisonViews?.funnels.details).toEqual([]);expect(global.clients[0].details).toHaveLength(6);
 expect(observations.mock.calls[0][5]).toEqual({datasets:['overview','funnels'],includeOperations:false,includePriorWeek:false,trendDatasets:['overview']});
});

it('retains selected historical AI priorities beside a newer daily review with the same Findings queue keys',async()=>{
 const filters=parseFilters(new URLSearchParams({from:'2026-10-15',to:'2026-10-15',mode:'closed',compare:'custom',compareFrom:'2026-10-08',compareTo:'2026-10-08'}));
 const review=(id:string,date:string,selection:typeof filters,title:string)=>({id,clientId:'a',storeDate:date,createdAt:`${date}T12:00:00Z`,revision:1,current:true,payload:{type:'ai',filters:selection,actions:[{title,detail:'Dated evidence',nextStep:'Investigate',severity:'investigate',impact:null,sourceIds:[]}]}});
 const reviews=[review('selected-ai','2026-10-15',filters,'Review selected October 15 evidence'),review('latest-ai','2026-10-16',{...filters,from:'2026-10-16',to:'2026-10-16'},'Review latest October 16 evidence'),review('wrong-custom','2026-10-14',{...filters,compareFrom:'2026-10-07',compareTo:'2026-10-07'},'Different custom benchmark')];
 state.permitted=['a'];state.store={first:async()=>null,clients:async()=>[{...initialClients[0],id:'a',timezone:'UTC',version:1}],connections:async()=>[],observations:async()=>[],findings:async()=>[],reviews:async()=>reviews,note:async()=>({body:''}),jobs:async()=>[]};
 const params={from:filters.from,to:filters.to,mode:'closed',compare:'custom',compareFrom:filters.compareFrom!,compareTo:filters.compareTo!},portfolio=await loadWorkspace(new URLSearchParams({...params,section:'portfolio'})),findings=await loadWorkspace(new URLSearchParams({...params,section:'findings'}));
 expect(portfolio.clients[0].reviews.map(review=>review.id)).toEqual(['latest-ai','selected-ai']);
 const portfolioQueue=buildAlertQueue(portfolio.clients,portfolio.filters,{includeLatestReview:true}),findingsQueue=buildAlertQueue(findings.clients,findings.filters,{includeLatestReview:true});
 expect(portfolioQueue).toHaveLength(2);expect(portfolioQueue.map(alert=>alert.key).sort()).toEqual(findingsQueue.map(alert=>alert.key).sort());expect(portfolioQueue.map(alert=>alert.title)).not.toContain('Different custom benchmark');
});
