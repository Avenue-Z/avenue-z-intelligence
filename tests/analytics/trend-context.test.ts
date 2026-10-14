import {expect,it} from 'vitest';
import {contextSeries,trendContextRange,trendContextWindows} from '../../lib/analytics/trend-context';
import type {QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',compare:'weekday',mode:'partial',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
it('gives a single-day selection seven real calendar days and an aligned last-week comparison',()=>{
 expect(trendContextRange(filters,'7d')).toEqual({from:'2026-10-07',to:'2026-10-13',comparisonFrom:'2026-09-30',comparisonTo:'2026-10-06'});
 expect(trendContextRange({...filters,compare:'previous'},'7d')).toMatchObject({comparisonFrom:'2026-10-06',comparisonTo:'2026-10-12'});
});
it('loads only two bounded thirty-day windows even for distant custom comparisons',()=>{
 expect(trendContextWindows({...filters,compare:'custom',compareFrom:'2026-01-05'})).toEqual([['2026-09-14','2026-10-13'],['2025-12-07','2026-01-05']]);
 expect(trendContextRange(filters,'selected')).toMatchObject({from:filters.from,to:filters.to,comparisonFrom:'2026-10-06'});
});
it('keeps live selected values authoritative and unknown history unknown, including genuine zeros',()=>{
 const result=contextSeries([{date:'2026-10-13',sessions:5}],[{date:'2026-10-06',sessions:99},{date:'2026-10-07',sessions:0},{date:'2026-10-09',sessions:null},{date:'2026-10-13',sessions:100}],{from:'2026-10-07',to:'2026-10-13'});
 expect(result).toEqual([{date:'2026-10-07',sessions:0},{date:'2026-10-09',sessions:null},{date:'2026-10-13',sessions:5}]);
});
it('prefers normalized context to full earlier selected days while retaining selected-period semantics',()=>{
 const selected=[{date:'2026-10-12',revenue:1000},{date:'2026-10-13',revenue:20}],history=[{date:'2026-10-12',revenue:10},{date:'2026-10-13',revenue:20}],range={from:'2026-10-12',to:'2026-10-13'};
 expect(contextSeries(selected,history,range,true)).toEqual(history);expect(contextSeries(selected,history,range)).toEqual(selected);
});
