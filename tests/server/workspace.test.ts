import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({store:null as any}));
vi.mock('../../lib/server/access',()=>({requireClientAccess:async()=>({organizationId:'o',permittedClientIds:['a'],role:'admin'}),getStore:()=>state.store}));
import {loadWorkspace} from '../../lib/server/workspace';
it('resolves an old archive date before loading its detail tables',async()=>{
 const client={id:'a',name:'A',timezone:'UTC',currency:'USD',config:{incidents:[],spendChannels:[],benchmarkMarket:'US',minSessions:10,minOpportunity:1,maxActions:6}};
 const date='2026-01-03',row={date,dataset:'overview',metric:'revenue',value:100,currency:'USD',definition:'web',population:'web',quality:'historical',dimensions:{},retrievedAt:'old'};
 state.store={clients:async()=>[client],connections:async()=>[],observations:async(_o:string,_c:string,f:any,headlineOnly:boolean)=>headlineOnly?[row]:f.from===date?[row,{...row,dataset:'funnels',metric:'sessions',value:10,dimensions:{page:'/lp'}}]:[],findings:async()=>[],reviews:async()=>[],note:async()=>({body:''}),jobs:async()=>[]};
 const result=await loadWorkspace(new URLSearchParams());expect(result.filters.to).toBe(date);expect(result.clients[0].details).toHaveLength(1);
});
