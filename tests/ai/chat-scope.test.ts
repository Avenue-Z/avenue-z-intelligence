import {expect,it} from 'vitest';
import {chatDatasets} from '../../lib/ai/chat-scope';
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
