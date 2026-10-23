import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'beam',name:'Beam',slug:'beam',timezone:'America/New_York',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'all_channel_net_including_recurring_excl_faire',spendChannels:['Meta'],recurringLabel:'Loop Subscriptions',minSessions:700,minOpportunity:5,maxActions:6,reviewTime:'08:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function render(selected=filters,brand=client){
 const rows:Observation[]=[{date:selected.to,dataset:'overview',metric:'revenue',value:100,definition:'net_sales',population:'orders',dimensions:{},sourceId:'archive-beam',currency:'USD',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:null,quality:'historical'}];
 const record={...workspacePresentation(queryClient(brand,rows,[],selected,{prepareAllViews:true}),selected),reviews:[],findings:[],note:{body:'',version:0}};
 return renderToStaticMarkup(createElement(ClientWorkspace,{record,filters:selected,update:()=>{},mutate:async()=>{},admin:false}));
}
it('routes the Beam overview to store performance without subscription operations',()=>{
 const html=render();
 expect(html).toContain('ALL-CHANNEL NET SALES');
 expect(html).not.toContain('LOOP SUBSCRIPTIONS NET SALES');
 expect(html).not.toContain('>Subscriptions</button>');
 expect(html).not.toContain('RENEWAL REVENUE SHARE');
 expect(html).not.toContain('Live diagnostics unavailable');
 expect(html).not.toContain('Online Store / Meta MER');
 expect(html).toContain('Historical report');
 expect(html).not.toContain('Closed-day MER');
});
it('does not describe KP-only media providers in Beam source coverage',()=>{
 const html=render({...filters,view:'media'});
 expect(html).not.toContain('AppLovin campaign reports use UTC');
 expect(html).not.toContain('matched Triple Whale spend feed');
});
it('retains the existing Kind Patches overview and its media source context',()=>{
 const kind={...client,id:'kind-patches',slug:'kind-patches',name:'Kind Patches',config:{...client.config,recurringLabel:'Subscription Recurring Order'}};
 expect(render(filters,kind)).toContain('Closed-day MER');
 expect(render(filters,kind)).not.toContain('ONLINE STORE NET SALES');
 expect(render({...filters,view:'media'},kind)).toContain('matched Triple Whale spend feed');
});

it('keeps disabled subscription URLs out of subscription operations',()=>{
 const html=render({...filters,view:'subscriptions'});
 expect(html).toContain('ALL-CHANNEL NET SALES');
 expect(html).not.toContain('Subscription analysis');
 expect(html).not.toContain('>Subscriptions</button>');
});
