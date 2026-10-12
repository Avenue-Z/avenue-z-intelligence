import {it,expect} from 'vitest';
import {validateClient,validateConnection} from '../../lib/server/configuration';
import initial from '../../data/initial-clients.json';
it('rejects credentials embedded in client configuration',()=>expect(()=>validateClient({...initial[0],config:{...initial[0].config,apiKey:'secret'}})).toThrow('Credentials'));
it('validates timezone and safe source endpoints',()=>{expect(()=>validateClient({...initial[0],timezone:'guess'})).toThrow();expect(()=>validateConnection({name:'source',clientId:'a',endpoint:'http://localhost',secretRef:'API_SECRET',pollMinutes:15})).toThrow();});
it('rejects invalid reporting hours and minutes',()=>{for(const reviewTime of ['99:99','09:60','24:00'])expect(()=>validateClient({...initial[0],config:{...initial[0].config,reviewTime}})).toThrow();});
it('cannot send the internal runner secret to a data endpoint',()=>expect(()=>validateConnection({name:'source',clientId:'a',endpoint:'https://api.example.com',secretRef:'RUNNER_SECRET',pollMinutes:15})).toThrow());
it('prevents sending the Kind Patches credential bundle to an arbitrary gateway',()=>expect(()=>validateConnection({name:'source',clientId:'kind-patches',endpoint:'https://other.example.com',secretRef:'SOURCE_KIND_PATCHES_SCRIPT',pollMinutes:15})).toThrow());
