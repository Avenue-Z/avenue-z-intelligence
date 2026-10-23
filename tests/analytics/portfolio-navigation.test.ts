import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {portfolioRequestParams} from '../../components/analytics/dashboard';

it('clears hidden client cuts and drill scope while preserving the portfolio comparison',()=>{
 const input=new URLSearchParams({section:'portfolio',view:'subscriptions',from:'2026-10-15',to:'2026-10-16',compare:'custom',compareFrom:'2026-10-12',compareTo:'2026-10-13',mode:'partial',market:'US',source:'Meta',device:'mobile',stream:'recurring',page:'/pages/x',drill:'traffic-page'}),next=portfolioRequestParams(input);
 expect(next.get('view')).toBe('overview');for(const key of ['market','source','device','stream','page'])expect(next.get(key)).toBe('');
 for(const key of ['from','to','compare','compareFrom','compareTo','mode'])expect(next.get(key)).toBe(input.get(key));expect(next.has('drill')).toBe(false);
 expect(input.get('market')).toBe('US');
});
it('preserves focused client and global findings cuts',()=>{
 for(const extra of ([{clientId:'beam'},{section:'findings'}] as Record<string,string>[])){const input=new URLSearchParams({...extra,view:'traffic',source:'Meta',page:'/pages/x',drill:'traffic-page'});expect(portfolioRequestParams(input).toString()).toBe(input.toString());}
});
