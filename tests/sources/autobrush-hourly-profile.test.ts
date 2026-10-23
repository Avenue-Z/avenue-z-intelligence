import {expect,it} from 'vitest';
import type {Client} from '../../lib/analytics/contracts';
import {normalizeHourlyTraffic} from '../../lib/sources/shopify-hourly-traffic';
import {validateBatch} from '../../lib/sources/qualification';
const client:Client={id:'autobrush',slug:'autobrush',name:'Autobrush',timezone:'America/New_York',currency:'USD',color:'#b7f62c',version:1,config:{markets:['US','CA','GB'],benchmarkMarket:'US',revenueDefinition:'shopify_net_sales_all_channels',spendChannels:['meta'],recurringLabel:'Recurring',minSessions:700,minOpportunity:5,maxActions:6,reviewTime:'08:00',reviewTimezone:'America/New_York',reviewMode:'closed',subscriptionsEnabled:false,incidents:[]}};
const date='2026-10-21',counts={sessions:20,sessions_with_cart_additions:4,sessions_that_reached_checkout:3,sessions_that_completed_checkout:2};
const batch=()=>normalizeHourlyTraffic({detail:[{day:date,hour_of_day:10,landing_page_path:'/pages/offer',session_country:'Canada',session_device_type:'Mobile',referrer_source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'Brand',...counts}],hourly:[{day:date,hour_of_day:10,...counts}],daily:[{day:date,...counts}]},client,{from:date,to:date},new Date('2026-10-22T12:00:00Z'));
it('normalizes Autobrush hourly global public traffic under its own identity',()=>{
 const result=batch();expect(result.clientId).toBe('autobrush');expect(Date.parse(result.coverageThrough!)).toBe(Date.parse('2026-10-22T04:00:00Z'));
 expect(result.rows.find(row=>row.metric==='sessions')).toMatchObject({value:20,start:'2026-10-21T14:00:00Z',end:'2026-10-21T15:00:00Z',dimensions:{market:'CA'}});
});
it('cannot use the Autobrush expanded traffic profile for another brand or for financial facts',()=>{
 const result=batch();expect(()=>validateBatch({...result,clientId:'kind-patches'},'kind-patches',{autobrushTrafficHourly:true})).toThrow();
 expect(()=>validateBatch({...result,rows:result.rows.map(row=>({...row,dataset:'overview',metric:'revenue'}))},'autobrush',{autobrushTrafficHourly:true})).toThrow();
});
