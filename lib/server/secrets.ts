import {env} from '@avenue/runtime';
export function serverSecret(ref:string){const v=(env as unknown as Record<string,unknown>)[ref]??process.env[ref];return typeof v==='string'?v:null;}
