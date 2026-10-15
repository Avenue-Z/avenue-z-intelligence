import {expect,it} from 'vitest';
import {chatDatasets,chatNeedsMonthHistory,chatNeedsReviewBody,chatObservationSelection} from '../../lib/ai/chat-scope';
it('keeps same-time landing questions on selected and comparison detail only',()=>{
 const selection=chatObservationSelection('traffic','Which market has the weakest checkout completion today, versus the same time yesterday?');
 expect(selection).toMatchObject({dimensions:true,includePriorWeek:false,trendDatasets:[]});expect(selection.datasets).toEqual(expect.arrayContaining(['traffic','funnels','markets']));
 expect(chatNeedsMonthHistory('Did spend grow faster than revenue?')).toBe(false);expect(chatNeedsReviewBody('What needs our attention?')).toBe(false);
});
it('retains explicitly requested chart and historical context without adding an unrelated month export',()=>{
 for(const question of ['Explain the seven-day sales chart','Show the weekly traffic trend','Explain monthly conversion history','Show traffic over time','Show the past 14 days'])expect(chatObservationSelection('traffic',question).trendDatasets).toContain('traffic');
 expect(chatNeedsMonthHistory('Show MTD revenue')).toBe(true);expect(chatNeedsMonthHistory('Compare month-to-date revenue with last month')).toBe(true);expect(chatNeedsMonthHistory('Show the past 30 days')).toBe(false);
 expect(chatNeedsReviewBody('Explain the daily review')).toBe(true);expect(chatNeedsReviewBody('What did the report recommend?')).toBe(true);
});
it('loads the media charts without unrelated creative-level reports',()=>{
 const datasets=chatDatasets('media','In the seven-day charts, give actual revenue, ad spend and MER for October 7 and October 13.');
 expect(datasets).toEqual(['media','overview','revenue']);
 expect(chatDatasets('media','How was ad spend performance yesterday?')).not.toContain('creatives');
 expect(chatDatasets('media','Which period had higher ad spend?')).not.toContain('creatives');
});
it('loads campaign reports when the question asks for their actual cost metrics',()=>{
 expect(chatDatasets('media','Compare campaign CPC, CPM and CTR')).toContain('creatives');
 expect(chatDatasets('traffic','How did clicks and impressions change?')).toContain('creatives');
 expect(chatDatasets('media','Which ads performed best?')).toContain('creatives');
 expect(chatDatasets('media','Show ad-level performance')).toContain('creatives');
});
