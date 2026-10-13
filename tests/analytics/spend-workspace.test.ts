import {it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {SpendWorkspace} from '../../components/analytics/spend-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,QueryFilters} from '../../lib/analytics/contracts';
const client:Client={id:'test',name:'Test',slug:'test',timezone:'UTC',currency:'USD',color:'#416bc3',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:['meta'],recurringLabel:'Recurring',minSessions:100,minOpportunity:10,maxActions:5,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',view:'media',mode:'closed',compare:'previous',market:'',source:'',page:'',stream:'',device:''};
it('does not render empty dated charts when only unmatched platform ad metrics exist',()=>{
 const analytics=queryClient(client,[{date:filters.to,dataset:'creatives',metric:'meta_ad_spend',value:99,dimensions:{ad:'Pixel ad'},definition:'meta_platform_spend',population:'platform_ads',currency:'USD',sourceId:'meta',quality:'complete',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T00:00:00Z'}],[],filters,{prepareAllViews:true}),record={...workspacePresentation(analytics,filters),reviews:[],findings:[],note:{body:'',version:0}};
 const html=renderToStaticMarkup(createElement(SpendWorkspace,{record,filters}));
 expect(html).toContain('Spend vs revenue');expect(html).toContain('Matched revenue and spend values are unavailable');expect(html).not.toContain('No chart data for this selection');expect(html).not.toContain('Spend efficiency over time');
});
it('colors measurable ad-spend cost declines favorably and increases unfavorably',()=>{
 const base={...workspacePresentation(queryClient(client,[],[],filters),filters),reviews:[],findings:[],note:{body:'',version:0}};
 for(const [spend,tone] of [[80,'favorable'],[120,'unfavorable']] as const){const record={...base,metrics:{...base.metrics,spend},prior:{...base.prior,spend:100}},html=renderToStaticMarkup(createElement(SpendWorkspace,{record,filters}));
  const card=html.match(/<span>AD SPEND<\/span>[\s\S]*?<\/div>/)?.[0]??'';expect(card).toContain(`data-tone="${tone}"`);expect(card).toContain('vs yesterday');
 }
});
