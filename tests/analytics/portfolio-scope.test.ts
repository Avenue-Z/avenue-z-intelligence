import {expect,it} from 'vitest';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
import {canonicalPortfolioFilters,compactPortfolioMediaReports,isPortfolioScope,portfolioDatasets,portfolioObservationSelection} from '../../lib/analytics/portfolio-scope';
const filters:QueryFilters={from:'2026-10-15',to:'2026-10-16',period:'today',mode:'partial',compare:'custom',compareFrom:'2026-10-01',compareTo:'2026-10-02',view:'products',market:'US',source:'facebook',stream:'Online Store',device:'mobile',page:'/old-page'};
const report:Observation={date:'2026-10-15',dataset:'media',metric:'platform_spend',value:100,definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',currency:'USD',dimensions:{channel:'meta',provider_as_of:'2026-10-16T05:00:00Z',reporting_timezone:'provider_account_timezone_unverified'},sourceId:'beam-motion',retrievedAt:'2026-10-16T05:05:00Z',coverageThrough:null,quality:'complete'};

it('clears only portfolio view/dimensions and preserves every date, live-period and comparison field',()=>{
 const original=structuredClone(filters),canonical=canonicalPortfolioFilters(filters);
 expect(canonical).toEqual({...filters,view:'overview',market:'',source:'',stream:'',device:'',page:''});expect(filters).toEqual(original);expect(canonical).not.toBe(filters);
});
it('recognizes only unfocused default/portfolio sections while preserving archives, findings and focused client scope',()=>{
 for(const input of ['','section=portfolio','section='])expect(isPortfolioScope(new URLSearchParams(input))).toBe(true);
 for(const input of ['section=findings','section=reviews','section=settings','section=ai','clientId=beam','clientId=beam&section=portfolio'])expect(isPortfolioScope(new URLSearchParams(input))).toBe(false);
});
it('projects only the exact USD Motion Meta cohort and preserves zero, unknown and partial values',()=>{
 const excluded:Observation[]=[{...report,dataset:'creatives'},{...report,metric:'spend'},{...report,definition:'another_definition'},{...report,population:'another_population'},{...report,currency:'EUR'},{...report,dimensions:{...report.dimensions,channel:'google'}}],zero={...report,date:'2026-10-16',value:0,quality:'partial' as const},unknown={...report,date:'2026-10-17',value:null,quality:'historical' as const};
 expect(compactPortfolioMediaReports([report,...excluded,zero,unknown])).toEqual([{date:'2026-10-15',spend:100,currency:'USD',asOf:'2026-10-16T05:00:00Z',timezone:'provider_account_timezone_unverified',quality:'complete',sourceId:'beam-motion'},{date:'2026-10-16',spend:0,currency:'USD',asOf:'2026-10-16T05:00:00Z',timezone:'provider_account_timezone_unverified',quality:'partial',sourceId:'beam-motion'},{date:'2026-10-17',spend:null,currency:'USD',asOf:'2026-10-16T05:00:00Z',timezone:'provider_account_timezone_unverified',quality:'historical',sourceId:'beam-motion'}]);
});
it('deduplicates identical observations but retains differing same-date reports for strict downstream qualification',()=>{
 const exactCopy={...report,dimensions:{reporting_timezone:report.dimensions.reporting_timezone,provider_as_of:report.dimensions.provider_as_of,channel:'meta'}},later={...report,value:120,retrievedAt:'2026-10-16T06:05:00Z',dimensions:{...report.dimensions,provider_as_of:'2026-10-16T06:00:00Z'}},partial={...report,quality:'partial' as const},otherSource={...report,sourceId:'another-motion-capture'};
 const reports=compactPortfolioMediaReports([report,exactCopy,later,partial,otherSource]);expect(reports).toHaveLength(4);expect(reports.map(row=>row.spend).sort()).toEqual([100,100,100,120]);expect(reports.filter(row=>row.date==='2026-10-15')).toHaveLength(4);expect(reports.some(row=>row.quality==='partial')).toBe(true);
});
it('keeps missing or malformed provider metadata unknown without inventing a reporting timezone',()=>{
 expect(compactPortfolioMediaReports([{...report,dimensions:{channel:'meta',provider_as_of:'unparseable'}}])[0]).toMatchObject({asOf:null,timezone:null,quality:'complete'});
});

it('keeps the shared portfolio datasets compact and caller-owned for both store scopes',()=>{
 const kp=portfolioDatasets('kind-patches'),beam=portfolioDatasets('beam');expect(kp).toEqual(['overview','funnels']);expect(beam).toEqual(['overview','funnels','media']);kp.push('subscriptions');beam.push('creatives');expect(portfolioDatasets('kind-patches')).toEqual(['overview','funnels']);expect(portfolioDatasets('beam')).toEqual(['overview','funnels','media']);
});

it('loads selected/comparison portfolio funnels with only overview and Beam media trend context',()=>{
 expect(portfolioObservationSelection('kind-patches')).toEqual({datasets:['overview','funnels'],includePriorWeek:false,includeOperations:false,trendDatasets:['overview']});
 expect(portfolioObservationSelection('beam')).toEqual({datasets:['overview','funnels','media'],includePriorWeek:false,includeOperations:false,trendDatasets:['overview','media']});
});
