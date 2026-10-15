import type {QueryFilters} from './contracts';
import {todayIn,shiftDate} from './windows';

export function livePeriodFilterChanges(filters:QueryFilters,changes:Record<string,string>,timezone:string):Record<string,string>{
 if(changes.period==='today'){const today=todayIn(timezone);return {...changes,from:today,to:today,mode:'partial',compare:'previous'};}
 if(changes.from||changes.to){const to=changes.to??filters.to,today=todayIn(timezone);return {...changes,period:'',...changes.mode?{}:to<today?{mode:'closed'}:to===today?{mode:'partial'}:{}};}
 if(changes.mode==='closed'){const date=shiftDate(todayIn(timezone),-1);return {...changes,period:'',...filters.period==='today'?{from:date,to:date}:{}};}
 return changes;
}
/** An explicit date change must not regain the previous live marker while its
 * response is loading. A bare fresh URL inherits the server's live default.
 */
export function workspaceRefreshParams(search:string,filters:QueryFilters):URLSearchParams{
 const params=new URLSearchParams(search),explicitDates=params.has('from')||params.has('to');
 if(filters.period==='today'&&!explicitDates&&!params.has('period'))params.set('period','today');
 for(const [key,value]of Object.entries(filters))if(key!=='period'&&!params.has(key))params.set(key,value);
 return params;
}
