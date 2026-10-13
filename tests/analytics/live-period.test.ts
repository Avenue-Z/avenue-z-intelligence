import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {livePeriodFilterChanges,workspaceRefreshParams} from '../../lib/analytics/live-period';
import type {QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',period:'today',mode:'partial',compare:'weekday',view:'products',market:'',stream:'Online Store',source:'',device:'',page:''};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));});afterEach(()=>vi.useRealTimers());
it('clears the live marker when a user picks historical dates and preserves it for tab and comparison changes',()=>{
 expect(livePeriodFilterChanges(filters,{from:'2026-10-10'},'Europe/Stockholm')).toEqual({from:'2026-10-10',period:'',mode:'partial'});
 expect(livePeriodFilterChanges(filters,{view:'revenue',compare:'previous'},'Europe/Stockholm')).toEqual({view:'revenue',compare:'previous'});
 expect(livePeriodFilterChanges(filters,{to:'2026-10-10'},'Europe/Stockholm')).toEqual({to:'2026-10-10',period:'',mode:'closed'});
});
it('opens closed yesterday from a live view and refreshes today in the store timezone',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T22:30:00Z'));try{
  expect(livePeriodFilterChanges(filters,{mode:'closed'},'Europe/Stockholm')).toEqual({mode:'closed',period:'',from:'2026-10-13',to:'2026-10-13'});
  expect(livePeriodFilterChanges(filters,{period:'today'},'Europe/Stockholm')).toEqual({period:'today',from:'2026-10-14',to:'2026-10-14',mode:'partial'});
 }finally{vi.useRealTimers();}
});
it('does not restore an old live marker during the pending response to an explicit date selection',()=>{
 const historical=workspaceRefreshParams('?from=2026-10-10&to=2026-10-10',filters);
 expect(historical.has('period')).toBe(false);expect(historical.get('from')).toBe('2026-10-10');
 expect(workspaceRefreshParams('?view=products',filters).get('period')).toBe('today');
 expect(workspaceRefreshParams('?period=today&from=2026-10-13&to=2026-10-13',filters).get('period')).toBe('today');
});
