import {expect,it} from 'vitest';
import type {Connection} from '../../lib/analytics/contracts';
import {liveReportingDate} from '../../lib/analytics/reporting-date';
import {confirmedIntradayCutoff} from '../../lib/analytics/intraday-coverage';

const source=(provider:Connection['provider'],coverageThrough:string|null,enabled=true)=>({id:provider,provider,enabled,coverageThrough}) as Connection;
it('keeps the live selection on the captured store day after calendar midnight',()=>{
 const sources=[source('kind-shopify-sales','2026-10-13T21:00:00Z')];
 expect(liveReportingDate(sources,'revenue','Europe/Stockholm',new Date('2026-10-13T22:30:00Z'))).toBe('2026-10-13');
});
it('advances only when all primary feeds have a complete first hour of the new store day',()=>{
 const now=new Date('2026-10-13T23:15:00Z');
 const sources=[source('kind-triple-whale','2026-10-13T23:00:00Z'),source('kind-recharge-cancellations','2026-10-13T22:59:00Z')];
 expect(liveReportingDate(sources,'subscriptions','Europe/Stockholm',now)).toBe('2026-10-13');
 sources[1].coverageThrough='2026-10-13T23:00:00Z';
 expect(liveReportingDate(sources,'subscriptions','Europe/Stockholm',now)).toBe('2026-10-14');
});
it('selects each view by its own primary feed without stale auxiliary sources holding it back',()=>{
 const now=new Date('2026-10-13T23:15:00Z'),sources=[source('kind-shopify-sales','2026-10-13T23:00:00Z'),source('kind-shopify-traffic','2026-10-13T21:00:00Z'),source('kind-applovin','2026-10-12T20:00:00Z')];
 expect(liveReportingDate(sources,'revenue','Europe/Stockholm',now)).toBe('2026-10-14');
 expect(liveReportingDate(sources,'traffic','Europe/Stockholm',now)).toBe('2026-10-13');
});
it('uses the full preceding day when coverage ends exactly at store midnight',()=>{
 const sources=[source('kind-shopify-sales','2026-10-13T22:00:00Z')];
 expect(liveReportingDate(sources,'revenue','Europe/Stockholm',new Date('2026-10-13T22:05:00Z'))).toBe('2026-10-13');
 expect(confirmedIntradayCutoff(sources,'revenue','Europe/Stockholm','2026-10-13')).toBe('2026-10-13T22:00:00Z');
});
it('retains the calendar default when primary coverage is unconfirmed and never anchors to a future capture',()=>{
 const now=new Date('2026-10-13T22:30:00Z');
 for(const sources of [[],[source('kind-shopify-sales',null)],[source('kind-shopify-sales','invalid')],[source('kind-shopify-sales','2026-10-14T00:00:00Z')]])
  expect(liveReportingDate(sources,'revenue','Europe/Stockholm',now)).toBe('2026-10-14');
});
