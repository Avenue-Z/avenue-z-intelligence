import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({store:null as any}));
vi.mock('../../lib/server/access',()=>({requireClientAccess:async()=>({organizationId:'o',permittedClientIds:['a'],role:'admin'}),getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
import {loadWorkspace,workspaceSearchParams,parseFilters} from '../../lib/server/workspace';
it('preserves shared URL scope for the initial server render',()=>{const p=workspaceSearchParams({from:'2026-09-10',to:'2026-10-08',view:'reviews',section:['findings','portfolio']});expect(p.get('from')).toBe('2026-09-10');expect(p.get('to')).toBe('2026-10-08');expect(p.get('section')).toBe('findings');});
it('resolves an old archive date before loading its detail tables',async()=>{
 const client={id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}};
 const date='2026-01-03',row={date,dataset:'overview',metric:'revenue',value:100,currency:'USD',definition:'web',population:'web',quality:'historical',dimensions:{},retrievedAt:'old'};
 state.store={first:async()=>null,clients:async()=>[client],connections:async()=>[],observations:async(_o:string,_c:string,f:any,headlineOnly:boolean)=>headlineOnly?[row]:f.from===date?[row,{...row,dataset:'funnels',metric:'sessions',value:10,dimensions:{page:'/lp'}}]:[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams());expect(result.filters.to).toBe(date);expect(result.clients[0].details).toHaveLength(1);
});

it("canonicalizes legacy country URL filters before rendering the dropdown",()=>{expect(parseFilters(new URLSearchParams()).market).toBe("");expect(parseFilters(new URLSearchParams({market:"France"})).market).toBe("FR");expect(parseFilters(new URLSearchParams({market:"United Kingdom"})).market).toBe("UK");expect(parseFilters(new URLSearchParams({market:"Atlantis"})).market).toBe("Atlantis");});
