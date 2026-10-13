import {expect,it} from 'vitest';
import {intradayConnections,confirmedIntradayCutoff} from '../../lib/analytics/intraday-coverage';
import type {Connection} from '../../lib/analytics/contracts';
const sources=['kind-triple-whale','kind-shopify-hourly','kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-recharge-cancellations','kind-applovin','kind-triple-whale-diagnostics'].map(provider=>({id:provider,provider,enabled:true})) as Connection[];
it('uses the actual primary feed of each client view rather than clipping sales and products to another feed',()=>{
 expect(intradayConnections(sources,'revenue').map(source=>source.provider)).toEqual(['kind-shopify-sales','kind-triple-whale-diagnostics']);
 expect(intradayConnections(sources,'products').map(source=>source.provider)).toEqual(['kind-shopify-products']);
 expect(intradayConnections(sources,'markets').map(source=>source.provider)).toEqual(['kind-triple-whale']);
 expect(intradayConnections(sources,'traffic').map(source=>source.provider)).toEqual(['kind-shopify-traffic']);
 expect(intradayConnections(sources,'subscriptions').map(source=>source.provider)).toEqual(['kind-triple-whale','kind-recharge-cancellations','kind-triple-whale-diagnostics']);
 expect(intradayConnections(sources,'media').map(source=>source.provider)).toEqual(['kind-triple-whale','kind-shopify-hourly']);
});
it('matches overview financial panels to their shared captured hour without waiting for unrelated providers',()=>{
 const coverage=sources.map(source=>({...source,coverageThrough:['kind-shopify-sales','kind-triple-whale-diagnostics'].includes(source.provider)?'2026-10-13T21:00:00Z':['kind-triple-whale','kind-shopify-hourly'].includes(source.provider)?'2026-10-13T22:00:00Z':null}));
 expect(intradayConnections(coverage,'overview').map(source=>source.provider)).toEqual(['kind-triple-whale','kind-shopify-hourly','kind-shopify-sales','kind-triple-whale-diagnostics']);
 expect(confirmedIntradayCutoff(coverage,'overview','Europe/Stockholm','2026-10-13')).toBe('2026-10-13T21:00:00Z');
 expect(confirmedIntradayCutoff(coverage,'markets','Europe/Stockholm','2026-10-13')).toBe('2026-10-13T22:00:00Z');
});
it('preserves the actual completed repeated store hour on the current date',()=>{
 const source={id:'tw',provider:'kind-triple-whale',enabled:true,coverageThrough:'2026-11-01T06:35:00Z'} as Connection;
 expect(confirmedIntradayCutoff([source],'markets','America/New_York','2026-11-01')).toBe('2026-11-01T06:00:00Z');
 expect(confirmedIntradayCutoff([source],'markets','America/New_York','2026-10-31')).toBe('2026-10-31T05:00:00Z');
});
it('keeps gateway coverage requirements and falls back to the hourly landing-page source when no detailed traffic feed is configured',()=>{
 const gateway={id:'gateway',provider:'gateway',enabled:true} as Connection;
 expect(intradayConnections([gateway,...sources.filter(source=>source.provider!=='kind-shopify-traffic')],'traffic').map(source=>source.id)).toEqual(['gateway','kind-triple-whale','kind-shopify-hourly']);
 expect(intradayConnections([{...gateway,enabled:false}], 'revenue')).toEqual([]);
});
