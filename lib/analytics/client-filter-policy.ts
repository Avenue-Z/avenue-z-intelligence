import type {QueryFilters} from './contracts';

export const dimensionFilterKeys=['market','stream','source','device','page'] as const;
export type DimensionFilterKey=typeof dimensionFilterKeys[number];

/** A filter belongs to a view only when its primary provider can answer it.
 * In particular, Shopify channel sales have no landing-page/device attribution.
 */
export function supportedClientFilters(view:string):readonly DimensionFilterKey[]{
 if(view==='revenue'||view==='products')return ['stream'];
 if(view==='markets')return ['market'];
 if(view==='traffic'||view==='funnels'||view==='ga4')return ['market','source','device','page'];
 return [];
}
export function unsupportedClientFilterReset(filters:QueryFilters,view=filters.view):Record<string,string>{
 const supported=supportedClientFilters(view);
 return Object.fromEntries(dimensionFilterKeys.filter(key=>filters[key]&&!supported.includes(key)).map(key=>[key,'']));
}
/** Today is a reporting window within the current view, not a navigation jump. */
export function clientTodaySelection(filters:QueryFilters,today:string):Record<string,string>{
 return {from:today,to:today,period:'today',mode:'partial',view:filters.view,...unsupportedClientFilterReset(filters)};
}
