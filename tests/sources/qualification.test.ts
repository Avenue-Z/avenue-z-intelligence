import { describe, it, expect } from 'vitest';
import { validateQualification, validateBatch, safeSourceUrl } from '../../lib/sources/qualification';

const record = { clientId:'a', queryId:'sales', timezone:'America/New_York', currency:'USD', hourlyGrain:true, requiredChannels:['meta','tiktok'], channels:['meta','tiktok'], requiredDimensions:['human'], dimensions:['human'], paginationComplete:true, reconciled:true };
describe('source qualification prevents fabricated completeness', () => {
  it.each([
    [{...record,channels:['meta']}, 'Missing channel: tiktok'],
    [{...record,timezone:''}, 'Invalid timezone'],
    [{...record,paginationComplete:false}, 'Pagination incomplete'],
    [{...record,dimensions:[]}, 'Missing dimension: human'],
    [{...record,hourlyGrain:false,requiresHourly:true}, 'Hourly data unavailable'],
  ])('rejects incompatible source coverage', (input, reason) => {
    expect(validateQualification(input).reasons).toContain(reason);
  });
  it('accepts reconciled matching coverage',()=>expect(validateQualification(record).status).toBe('qualified'));
  it('rejects foreign client data and malformed amounts',()=>{
    expect(()=>validateBatch({clientId:'b',rows:[]},'a')).toThrow('Client identity mismatch');
    expect(()=>validateBatch({clientId:'a',rows:[{date:'2026-10-07',metric:'revenue',value:'bad'}]},'a')).toThrow();
  });
  it.each(['http://example.com','https://127.0.0.1','https://10.2.0.1','https://[::1]','https://user:pass@example.com','https://localhost'])('rejects unsafe stored endpoints %s',url=>expect(()=>safeSourceUrl(url)).toThrow());
});
