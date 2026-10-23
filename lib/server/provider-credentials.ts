import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {Store} from './store';

export type ProviderCredentialIdentity={organizationId:string;clientId:string;provider:string};
type CredentialStore=Pick<Store,'first'|'run'>;
const maximumPayloadBytes=64*1024;
const maximumEnvelopeCharacters=3+16+1+Math.ceil(maximumPayloadBytes*4/3)+1+22;

function credentialContext(identity:ProviderCredentialIdentity,secret:string){
 if(!identity||typeof identity!=='object'||typeof secret!=='string'||secret.length<32)throw Error('Invalid credential configuration');
 const parts=[identity.organizationId,identity.clientId,identity.provider];
 if(parts.some(part=>typeof part!=='string'||!part.trim()||part.length>256||/[\u0000-\u001f\u007f]/.test(part)))throw Error('Invalid credential identity');
 return {key:createHash('sha256').update(secret,'utf8').digest(),aad:Buffer.from(JSON.stringify(['provider_credentials',1,...parts]),'utf8'),parts};
}

function encodePayload(payload:unknown){
 const json=JSON.stringify(payload,(_key,value:unknown)=>{
  if(value===undefined||['function','symbol','bigint'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error('Invalid credential payload');
  return value;
 });
 if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>maximumPayloadBytes)throw Error('Invalid credential payload');
 return Buffer.from(json,'utf8');
}

function decodePart(value:string){
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid credential envelope');
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value)throw Error('Invalid credential envelope');
 return bytes;
}

export async function saveProviderCredential(store:CredentialStore,identity:ProviderCredentialIdentity,payload:unknown,secret:string):Promise<void>{
 try{
  const {key,aad,parts}=credentialContext(identity,secret),plaintext=encodePayload(payload),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const envelope=['v1',iv.toString('base64url'),ciphertext.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
  await store.run('INSERT INTO provider_credentials (organizationId,clientId,provider,payload,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(organizationId,clientId,provider) DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt',...parts,envelope,new Date().toISOString());
 }catch{throw Error('Provider credential could not be saved');}
}

export async function readProviderCredential(store:CredentialStore,identity:ProviderCredentialIdentity,secret:string):Promise<unknown|null>{
 try{
  const {key,aad,parts}=credentialContext(identity,secret);
  const row=await store.first<{payload:unknown}>('SELECT payload FROM provider_credentials WHERE organizationId=? AND clientId=? AND provider=?',...parts);
  if(row===null)return null;
  if(typeof row.payload!=='string'||row.payload.length>maximumEnvelopeCharacters)throw Error('Invalid credential envelope');
  const segments=row.payload.split('.');if(segments.length!==4||segments[0]!=='v1')throw Error('Invalid credential envelope');
  const iv=decodePart(segments[1]),ciphertext=decodePart(segments[2]),tag=decodePart(segments[3]);
  if(iv.byteLength!==12||tag.byteLength!==16||ciphertext.byteLength>maximumPayloadBytes)throw Error('Invalid credential envelope');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad);decipher.setAuthTag(tag);
  const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
 }catch{throw Error('Provider credential could not be read');}
}
