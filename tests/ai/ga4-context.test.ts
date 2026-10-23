import {expect,it} from 'vitest';
import type {Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
import type {QueryFilters} from '../../lib/analytics/contracts';
import {buildGa4AIView} from '../../lib/ai/ga4-context';
import {buildAIContext,compactAIContextForModel,restoreAIContextSnapshot,validateAnswer} from '../../lib/ai/context';
import {buildChatModelContext} from '../../lib/ai/chat-input';
import {boundedAIContextForModel} from '../../lib/ai/model-input';
import {queryClient} from '../../lib/analytics/query';
import clients from '../../data/initial-clients.json';
import {shiftDate} from '../../lib/analytics/windows';

const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',mode:'partial',compare:'previous',view:'ga4',market:'US',source:'google',page:'/dream',device:'desktop',stream:''};
const summary={sessions:100,engagedSessions:60,purchases:0,revenue:0},unknown={sessions:null,engagedSessions:null,purchases:null,revenue:null};
function fixture():Ga4Dashboard{
 const groups=Array.from({length:100},(_,index)=>({label:index===99?'/special-dream-offer':`/page-${index}`,current:{...summary,sessions:100-index},previous:{...summary,sessions:90-index}}));
 return {from:filters.from,to:filters.to,comparison:{from:'2026-10-15',to:'2026-10-15'},timezone:'America/New_York',currency:'USD',propertyId:'292550743',latestCapturedAt:'2026-10-16T17:30:00Z',matchedThroughHour:9,coverage:{requestedDays:1,capturedDays:1,missingDates:[],availableFrom:'2026-09-17',availableTo:'2026-10-16'},current:{...summary},previous:{...unknown},daily:Array.from({length:30},(_,index)=>({date:shiftDate(filters.to,index-29),comparisonDate:shiftDate(filters.to,index-30),current:index===29?{...summary}:{...unknown},previous:{...unknown}})),pages:groups,sources:groups.map((row,index)=>({...row,label:`source-${index}`})),markets:[{label:'US',current:{...summary},previous:{...unknown}}],devices:[{label:'desktop',current:{...summary},previous:{...unknown}}],filterOptions:{markets:['US'],sources:['google'],pages:['/dream'],devices:['desktop']},quality:{sampled:false,thresholded:true,dataLossFromOtherRow:false,restricted:false,truncated:false}};
}
it('retains all backend groups for platform ranking and pagination while preserving default chat bounds',()=>{
 const frame=fixture(),groups=Array.from({length:245},(_,index)=>({label:`/page-${String(index).padStart(3,'0')}-`+'x'.repeat(1800),current:{...summary,sessions:500-index},previous:{...summary,sessions:400-index}}));
 frame.pages=groups;frame.sources=groups.map((value,index)=>({...value,label:`source-${index}`}));frame.groupCounts={pages:245,sources:245,markets:1,devices:1};const before=JSON.stringify(frame);
 const full=buildGa4AIView(frame,filters,'Compare GA4 landing pages',true),bounded=buildGa4AIView(frame,filters,'Compare GA4 landing pages');
 if(!full.available||!bounded.available)throw Error('Missing view');
 expect(full.pages).toMatchObject({groupCount:245,returnedGroupCount:245,omitted:0,backendOmitted:0});expect(full.sources.groups).toHaveLength(245);
 expect(full.pages.groups.slice(220,222)).toEqual(groups.slice(220,222));expect(full.current).toEqual(summary);expect(full.current).not.toHaveProperty('cvr');expect(full.current).not.toHaveProperty('mer');
 expect(bounded.pages.groups.length).toBeLessThanOrEqual(30);expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(30000);expect(JSON.stringify(frame)).toBe(before);
});
it('preserves displayed GA4 totals, true zero, null comparisons, filters, coverage and exclusive cutoff without deriving Shopify metrics',()=>{
 const frame=fixture(),before=JSON.stringify(frame),view=buildGa4AIView(frame,filters,'Explain this GA4 chart');
 expect(view.available).toBe(true);if(!view.available)throw Error('Missing view');
 expect(view.current).toEqual(summary);expect(view.previous).toEqual(unknown);expect(view.daily).toEqual(frame.daily);expect(view.scope).toMatchObject({filters,propertyId:'292550743',matchedThroughHour:9,timezone:'America/New_York',currency:'USD',latestCapturedAt:frame.latestCapturedAt});
 expect(view.coverage).toEqual(frame.coverage);expect(view.quality).toEqual(frame.quality);expect(view.current).not.toHaveProperty('mer');expect(view.current).not.toHaveProperty('cvr');expect(view.instruction).toContain('GA4-attributed');expect(JSON.stringify(frame)).toBe(before);
});
it('keeps question-matched small groups beyond the top twenty and reports complete group omission counts',()=>{
 const view=buildGa4AIView(fixture(),filters,'What happened on /special-dream-offer?');if(!view.available)throw Error('Missing view');
 expect(view.pages.groups.some(group=>group.label==='/special-dream-offer')).toBe(true);expect(view.pages.groupCount).toBe(100);expect(view.pages.groups.length).toBeLessThanOrEqual(30);expect(view.pages.omitted+view.pages.returnedGroupCount).toBe(100);
 expect(view.pages.groups.find(group=>group.label==='/special-dream-offer')?.current.sessions).toBe(1);
});
it('reserves an explicitly named low-volume page before many other pages sharing its generic words',()=>{
 const frame=fixture();frame.pages=frame.pages.map((group,index)=>({...group,label:`/pages/dream-${index}`}));
 const view=buildGa4AIView(frame,filters,'What happened on /pages/dream-99?');if(!view.available)throw Error('Missing view');
 expect(view.pages.groups.some(group=>group.label==='/pages/dream-99')).toBe(true);expect(view.pages.returnedGroupCount).toBeLessThanOrEqual(30);expect(view.pages.questionMatchCount).toBe(100);expect(view.pages.omitted+view.pages.returnedGroupCount).toBe(100);
});
it('bounds long exact group labels without truncating identities or claiming omitted groups are unavailable',()=>{
 const frame=fixture();frame.pages=frame.pages.map((group,index)=>({...group,label:`/pages/${index}-`+'a'.repeat(1800)}));
 const view=buildGa4AIView(frame,filters,'Compare landing pages');if(!view.available)throw Error('Missing view');
 expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(30000);expect(view.pages.omitted).toBeGreaterThan(0);expect(view.pages.groups.every(group=>frame.pages.some(original=>original.label===group.label))).toBe(true);expect(view.instruction).toContain('omitted');
});
it('represents an unavailable cached GA4 frame explicitly without invented numeric rows',()=>{
 const view=buildGa4AIView(null,filters,'Explain GA4');expect(view.available).toBe(false);expect(view).not.toHaveProperty('current');expect(view.instruction).toMatch(/unavailable/i);
});
it('retains original backend group counts and includes both backend and AI omissions',()=>{
 const frame=fixture();frame.groupCounts={pages:5000,sources:3000,markets:1,devices:1};
 const view=buildGa4AIView(frame,filters,'Explain the top pages');if(!view.available)throw Error('Missing view');
 expect(view.pages.groupCount).toBe(5000);expect(view.pages.backendReturnedGroupCount).toBe(100);expect(view.pages.backendOmitted).toBe(4900);expect(view.pages.omitted+view.pages.returnedGroupCount).toBe(5000);
 expect(view.current).toEqual(summary);
});
it('registers the GA4 citation and preserves the projection through chat, model preview and lossless saved-context compression',()=>{
 const client=clients.find(client=>client.id==='beam')!,base=queryClient(client as Parameters<typeof queryClient>[0],[],[],filters),view=buildGa4AIView(fixture(),filters,'Explain GA4');
 const context=buildAIContext([{...base,note:{body:'',version:0},findings:[],reviews:[],ga4View:view}],filters);
 const source=context.sources.find(source=>source.id==='ga4:beam');expect(source?.url).toContain('view=ga4');expect(source?.url).toContain('market=US');
 expect(context.clients[0].ga4View).toEqual(view);expect(context.clients[0].selectedView.instruction).toContain('not GA4 coverage');expect(context.clients[0].warnings.join(' ')).toContain('Legacy');
 expect(buildChatModelContext(context,'Explain the GA4 chart').context.clients[0].ga4View).toEqual(view);expect(boundedAIContextForModel(context).context.clients[0].ga4View).toEqual(view);
 expect(restoreAIContextSnapshot(JSON.parse(JSON.stringify(compactAIContextForModel(context)))).clients[0].ga4View).toEqual(view);
 expect(()=>validateAnswer({answer:'The displayed GA4 purchases are zero.',sourceIds:['ga4:beam'],followUps:[],caveats:[]},context.sources)).not.toThrow();
});
