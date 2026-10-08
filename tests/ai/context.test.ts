import {it,expect} from 'vitest';
import {buildAIContext,validateAnswer,STRATEGY_STANDARD} from '../../lib/ai/context';
import {queryClient} from '../../lib/analytics/query';
import clients from '../../data/initial-clients.json';
const filters={from:'2026-10-07',to:'2026-10-07',view:'funnels',mode:'closed',compare:'previous',market:'US',source:'facebook',page:'',stream:'',device:''} as const;
const client=clients[0] as any;
it('binds analysis to server-filtered evidence and keeps other dates distinct',()=>{
 const r=queryClient(client,[],[],filters);const ctx=buildAIContext([{...r,note:{body:'Scope note'},findings:[],reviews:[{id:'rev',storeDate:'2026-10-06',revision:1,payload:{text:'Old evidence'},createdAt:'now'}]}] as any,filters,'rev');
 expect(ctx.filters).toEqual(filters);expect(ctx.clients[0].selectedReview?.storeDate).toBe('2026-10-06');expect(ctx.clients[0].warnings.join(' ')).toContain('No source observations');expect(ctx.clients[0]).not.toHaveProperty('connections');
});
it('does not attach invented citations',()=>{
 expect(()=>validateAnswer({answer:'Claim',sourceIds:['invented'],followUps:[],caveats:[]},[{id:'real',label:'report',url:'/report'}])).toThrow('citation');
});
it('requires spend efficiency, contaminated recurring comparisons and no checkout diagnosis from CVR alone',()=>{expect(STRATEGY_STANDARD).toMatch(/spend.*revenue/i);expect(STRATEGY_STANDARD).toMatch(/four weeks/i);expect(STRATEGY_STANDARD).toMatch(/CVR.*checkout/i);});
