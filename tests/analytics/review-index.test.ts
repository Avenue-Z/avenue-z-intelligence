import {expect,it} from 'vitest';
import {workspaceReviewIndex} from '../../lib/reviews/index';
import type {Review} from '../../lib/analytics/contracts';
it('retains dated review summaries and actionable citations without repeating report bodies in every analytics view',()=>{
 const review:Review={id:'r',clientId:'kind-patches',storeDate:'2026-10-13',revision:2,current:true,fingerprint:'fixed',createdAt:'2026-10-13T13:00:00Z',payload:{type:'ai',title:'Kind Patches daily review',summary:'Sales grew faster than spend.',headlines:['Revenue +10%'],kpis:[{label:'Revenue',value:100}],filters:{from:'2026-10-13'},reportTiming:{cutoff:'2026-10-13T13:00:00Z'},generatedAt:'now',reviewStandardVersion:'2026-10',actions:[{title:'Inspect budget',sourceIds:['s']}],sources:[{id:'s',label:'Matched spend',url:'/evidence'}],sections:[{title:'Revenue',tables:[{rows:Array.from({length:1000},()=>['Full dated numeric appendix'])}]}],text:'x'.repeat(200000)}};
 const result=workspaceReviewIndex(review);
 expect(result).toMatchObject({id:'r',revision:2,current:true,payload:{type:'ai',summary:'Sales grew faster than spend.',reportTiming:review.payload.reportTiming,actions:review.payload.actions,sources:review.payload.sources,reviewStandardVersion:'2026-10'}});
 expect(result.payload.sections).toBeUndefined();expect(result.payload.text).toBeUndefined();expect(review.payload.sections).toBeDefined();expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(review).length/100);
});
