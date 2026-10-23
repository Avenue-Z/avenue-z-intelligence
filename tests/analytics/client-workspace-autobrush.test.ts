import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import initial from '../../data/initial-clients.json';
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {workspaceDatasets,workspaceObservationSelection} from '../../lib/analytics/workspace-datasets';
const client={...initial.find(c=>c.id==='autobrush')!,version:1} as Client;
const filters:QueryFilters={from:'2026-10-21',to:'2026-10-21',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function record(view:string){const f={...filters,view},rows:Observation[]=[{date:f.to,metric:'revenue',value:100,dataset:'overview',definition:'shopify_net_sales_all_channels',population:'shopify_sales',currency:'USD',dimensions:{},sourceId:'autobrush-shopify-sales',retrievedAt:'2026-10-22T12:00:00Z',coverageThrough:'2026-10-22T04:00:00Z',quality:'complete',start:'2026-10-21T04:00:00Z',end:'2026-10-21T05:00:00Z'},{date:f.to,metric:'platform_spend',value:25,dataset:'media',definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',currency:'USD',dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-22T05:00:00Z'},sourceId:'autobrush-motion',retrievedAt:'2026-10-22T12:00:00Z',coverageThrough:null,quality:'complete'}];return {...workspacePresentation(queryClient(client,rows,[],f,{prepareAllViews:true}),f),reviews:[],findings:[],note:{body:'',version:0}};}
it('renders Autobrush global commerce without Beam exclusions or unsupported spend cards',()=>{
 const html=renderToStaticMarkup(createElement(ClientWorkspace,{record:record('overview'),filters,update:()=>{},mutate:async()=>{},admin:true}));
 expect(html).toContain('NET SALES');expect(html).toContain('HUMAN SESSIONS');expect(html).toContain('Traffic &amp; conversion');expect(html).not.toContain('US HUMAN SESSIONS');expect(html).not.toContain('Faire');expect(html).not.toContain('AD SPEND');expect(html).not.toContain('Closed-day MER');expect(html).not.toContain('>Subscriptions</button>');
});
it('renders qualified provider-date Motion spend through the existing media presentation',()=>{
 const f={...filters,view:'media'},html=renderToStaticMarkup(createElement(ClientWorkspace,{record:record('media'),filters:f,update:()=>{},mutate:async()=>{},admin:true}));
 expect(html).toContain('META PLATFORM SPEND');expect(html).toContain('$25');expect(html).toContain('Motion report dates');
 expect(workspaceDatasets('media','autobrush')).toEqual(['overview','media','creatives']);expect(workspaceObservationSelection('media','autobrush').trendDatasets).toContain('media');
});

afterEach(()=>vi.useRealTimers());
it.each(['overview','ga4'])('links today’s closed review by its New York store date in the %s view',view=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 const base=record(view),brand={...client,config:{...client.config,reviewMode:'closed' as const}},reviews=[{id:'closed-21',clientId:client.id,storeDate:'2026-10-21',revision:1,fingerprint:'test',createdAt:'2026-10-22T13:18:00Z',payload:{type:'ai'},current:true}],html=renderToStaticMarkup(createElement(ClientWorkspace,{record:{...base,client:brand,reviews},filters:{...filters,view},update:()=>{},mutate:async()=>{},admin:true}));
 expect(html).toMatch(/href="\/clients\/autobrush\/reviews\/closed-21">Today(?:&#x27;|&#39;|')s review<\/a>/);
});
it.each(['overview','ga4'])('links today’s partial review using the store clock rather than the GA4 clock in the %s view',view=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 const base=record(view),brand={...client,config:{...client.config,reviewMode:'partial' as const}},reviews=[{id:'partial-22',clientId:client.id,storeDate:'2026-10-22',revision:1,fingerprint:'test',createdAt:'2026-10-22T05:15:00Z',payload:{type:'ai'},current:true}],html=renderToStaticMarkup(createElement(ClientWorkspace,{record:{...base,client:brand,reviews},filters:{...filters,view},update:()=>{},mutate:async()=>{},admin:true}));
 expect(html).toMatch(/href="\/clients\/autobrush\/reviews\/partial-22">Today(?:&#x27;|&#39;|')s review<\/a>/);
});
it('does not label an older closed review as today’s review',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T13:30:00Z'));
 const base=record('overview'),reviews=[{id:'stale-20',clientId:client.id,storeDate:'2026-10-20',revision:1,fingerprint:'test',createdAt:'2026-10-21T13:18:00Z',payload:{type:'ai'},current:true}],html=renderToStaticMarkup(createElement(ClientWorkspace,{record:{...base,reviews},filters,update:()=>{},mutate:async()=>{},admin:true}));
 expect(html).not.toMatch(/Today(?:&#x27;|&#39;|')s review/);
});
