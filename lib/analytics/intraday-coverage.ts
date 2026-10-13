import type {Connection} from './contracts';
import {Temporal} from '@js-temporal/polyfill';
import {dayWindow,matchedCutoff} from './windows';

/** The reporting cutoff belongs to the primary feed of the selected view.
 * Auxiliary reports with different populations retain their own timestamps.
 */
export function intradayConnections(connections:Connection[],view:string):Connection[]{
 const enabled=connections.filter(source=>source.enabled),traffic=enabled.some(source=>source.provider==='kind-shopify-traffic');
 const providers=view==='revenue'?['kind-shopify-sales']:view==='products'?['kind-shopify-products']:view==='markets'?['kind-triple-whale']:view==='subscriptions'?['kind-triple-whale','kind-recharge-cancellations']:view==='traffic'?traffic?['kind-shopify-traffic']:['kind-triple-whale','kind-shopify-hourly']:view==='funnels'?['kind-shopify-hourly']:['kind-triple-whale','kind-shopify-hourly'];
 return enabled.filter(source=>!source.provider||source.provider==='gateway'||providers.includes(source.provider));
}
export function confirmedIntradayCutoff(connections:Connection[],view:string,timezone:string,date:string):string|null{
 const sources=intradayConnections(connections,view),coverage=sources.map(source=>source.coverageThrough),start=Date.parse(dayWindow(date,timezone).start);
 if(!coverage.length||!coverage.every((value):value is string=>!!value&&Number.isFinite(Date.parse(value))&&Date.parse(value)>=start))return null;
 const cutoff=matchedCutoff(coverage,timezone);if(!cutoff)return null;
 const local=Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone);if(local.toPlainDate().toString()===date)return cutoff;
 const clock=local.toPlainTime();
 return Temporal.PlainDate.from(date).toZonedDateTime({timeZone:timezone,plainTime:clock}).toInstant().toString();
}
