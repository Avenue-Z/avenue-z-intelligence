import {expect,it} from 'vitest';
import {providerJson} from '../../lib/sources/kind-patches';

it('keeps the ordinary provider response cap while admitting the bounded hourly traffic export',async()=>{
 const json=JSON.stringify({rows:'x'.repeat(6_100_000)}),fetcher:typeof fetch=async()=>new Response(json);
 await expect(providerJson(fetcher,'https://example.com',{},Date.now()+10000)).rejects.toThrow('exceeds 6 MB');
 expect((await providerJson(fetcher,'https://example.com',{},Date.now()+10000,0,25000,16000000)).rows.length).toBe(6_100_000);
});
it('measures response bytes instead of accepting oversized multibyte text',async()=>{
 const fetcher:typeof fetch=async()=>new Response(JSON.stringify({rows:'é'.repeat(3_100_000)}));
 await expect(providerJson(fetcher,'https://example.com',{},Date.now()+10000)).rejects.toThrow('exceeds 6 MB');
});
