import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {SourcePanel,TeamSettings} from '../../components/analytics/settings';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Connection,QueryFilters} from '../../lib/analytics/contracts';
import type {Workspace} from '../../lib/server/workspace';

const originalTimezone=process.env.TZ;
afterEach(()=>{if(originalTimezone===undefined)delete process.env.TZ;else process.env.TZ=originalTimezone;});
const client:Client={id:'test',name:'Test client',slug:'test',timezone:'Europe/Stockholm',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'Europe/Stockholm',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'settings'};
const connection:Connection={id:'source',clientId:client.id,name:'Analytics source',provider:'gateway',endpoint:'https://example.com',secretRef:'SOURCE_ANALYTICS_API_KEY',pollMinutes:15,enabled:true,lastSuccess:'2026-10-12T13:00:00Z',coverageThrough:'2026-10-12T14:00:00Z',error:null,version:1};
const record={...workspacePresentation(queryClient(client,[],[connection],filters),filters),reviews:[],findings:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:false,lastJob:undefined}};
const data:Workspace={scope:{organizationId:'agency',actorId:'admin',role:'admin',permittedClientIds:[client.id]},filters,clients:[record],loadedAt:'2026-10-12T15:00:00Z',reportingDateNote:null,jobs:[{id:'job',clientId:client.id,dueAt:'2026-10-12T15:00:00Z',status:'pending',attempts:0}]};
const mutate=async()=>({});

it('keeps source retrieval and coverage markup identical across server and browser host timezones',()=>{
 process.env.TZ='UTC';
 const server=renderToStaticMarkup(createElement(SourcePanel,{record,mutate,admin:false}));
 process.env.TZ='America/New_York';
 const browser=renderToStaticMarkup(createElement(SourcePanel,{record,mutate,admin:false}));
 expect(browser).toBe(server);
 expect(server).toContain('Oct 12, 2026, 3:00 PM');
 expect(server).toContain('Oct 12, 2026, 4:00 PM');
 expect(server).toContain('Europe/Stockholm');
});

it('keeps background job history markup identical across host timezones and labels its UTC clock',()=>{
 process.env.TZ='UTC';
 const server=renderToStaticMarkup(createElement(TeamSettings,{data,mutate}));
 process.env.TZ='America/New_York';
 const browser=renderToStaticMarkup(createElement(TeamSettings,{data,mutate}));
 expect(browser).toBe(server);
 expect(server).toContain('Oct 12, 2026, 3:00 PM');
 expect(server).toContain('Due (UTC)');
});
