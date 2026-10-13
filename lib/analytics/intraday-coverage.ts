import type {Connection} from './contracts';
import {Temporal} from '@js-temporal/polyfill';
import {dayWindow,matchedCutoff} from './windows';

/** A view's hourly financial panels share their contributing feeds' cutoff.
 * Operational snapshots and unrelated platform reports keep their own scope.
 */
export function intradayConnections(connections:Connection[],view:string):Connection[]{
 const enabled=connections.filter(source=>source.enabled),traffic=enabled.some(source=>source.provider==='kind-shopify-traffic');
 const providers=view==='overview'?['kind-triple-whale','kind-shopify-hourly','kind-shopify-sales','kind-triple-whale-diagnostics']:view==='revenue'?['kind-shopify-sales','kind-triple-whale-diagnostics']:view==='products'?['kind-shopify-products']:view==='markets'?['kind-triple-whale']:view==='subscriptions'?['kind-triple-whale','kind-recharge-cancellations','kind-triple-whale-diagnostics']:view==='traffic'?traffic?['kind-shopify-traffic']:['kind-triple-whale','kind-shopify-hourly']:view==='funnels'?['kind-shopify-hourly']:['kind-triple-whale','kind-shopify-hourly'];
 return enabled.filter(source=>!source.provider||source.provider==='gateway'||providers.includes(source.provider));
}
export function confirmedIntradayCutoff(connections:Connection[],view:string,timezone:string,date:string):string|null{
 const sources=intradayConnections(connections,view),coverage=sources.map(source=>source.coverageThrough),start=Date.parse(dayWindow(date,timezone).start);
 if(!coverage.length||!coverage.every((value):value is string=>!!value&&Number.isFinite(Date.parse(value))&&Date.parse(value)>=start))return null;
 const cutoff=matchedCutoff(coverage,timezone);if(!cutoff)return null;
 // Coverage at the next midnight completes this entire selected store day.
 // Projecting 00:00 back onto its start would incorrectly remove every hour.
 if(Date.parse(cutoff)===Date.parse(dayWindow(date,timezone).end))return cutoff;
 const local=Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone);if(local.toPlainDate().toString()===date)return cutoff;
 const clock=local.toPlainTime();
 return Temporal.PlainDate.from(date).toZonedDateTime({timeZone:timezone,plainTime:clock}).toInstant().toString();
}
