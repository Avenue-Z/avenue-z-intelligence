import {it,expect} from 'vitest';
import {parseReviewArchive} from '../../lib/reviews/import';
const source={date:'2026-10-06',title:'Daily review',text:'Reported sales and next actions.',sourceUrl:'https://claude.ai/artifact/example'};
it('preserves each source date when importing a multi-day archive',()=>expect(parseReviewArchive([source,{...source,date:'2026-10-07'}]).map(r=>r.date)).toEqual(['2026-10-06','2026-10-07']));
it('rejects impossible dates before any archive record is saved',()=>expect(()=>parseReviewArchive([source,{...source,date:'2026-02-30'}])).toThrow());
it('rejects a non-HTTPS source in an archive',()=>expect(()=>parseReviewArchive([{...source,sourceUrl:'http://example.com'}])).toThrow());
