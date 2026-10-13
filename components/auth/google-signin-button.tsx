'use client';

import {useRef,useState} from 'react';
import {ArrowRight,LoaderCircle} from 'lucide-react';
import {requestGoogleSignIn} from '../../lib/auth/sign-in';

function GoogleMark(){
 return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22.56 12.25c0-.73-.06-1.42-.19-2.09H12v3.96h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.75 3.28-7.95Z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.8l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.17v2.84A11 11 0 0 0 12 23Z" fill="#34A853"/><path d="M5.84 13.97A6.6 6.6 0 0 1 5.5 12c0-.68.12-1.34.34-1.97V7.19H2.17A11 11 0 0 0 1 12c0 1.78.43 3.47 1.17 4.81l3.67-2.84Z" fill="#FBBC05"/><path d="M12 5.5c1.62 0 3.07.56 4.22 1.65l3.16-3.16A10.58 10.58 0 0 0 12 1a11 11 0 0 0-9.83 6.19l3.67 2.84C6.71 7.43 9.14 5.5 12 5.5Z" fill="#EA4335"/></svg>;
}

export function GoogleSignInButton({callbackUrl,className='primary-button google-signin-button'}:{callbackUrl:string;className?:string}){
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),inFlight=useRef(false);
 async function begin(){
  if(inFlight.current)return;
  inFlight.current=true;setPending(true);setError(null);
  try{const destination=await requestGoogleSignIn(callbackUrl,window.location.origin);window.location.assign(destination);}
  catch(failure){setError(failure instanceof Error?failure.message:'Google sign-in could not start. Please try again.');setPending(false);inFlight.current=false;}
 }
 return <><button type="button" className={className} onClick={begin} disabled={pending} aria-busy={pending} aria-describedby={error?'google-signin-error':undefined}>
  {pending?<LoaderCircle size={20} aria-hidden="true" className="animate-spin"/>:<GoogleMark/>}<span>{pending?'Opening Google…':'Continue with Google'}</span>{!pending&&<ArrowRight size={17} aria-hidden="true"/>}
 </button>{error&&<p id="google-signin-error" className="google-signin-error" role="alert">{error}</p>}</>;
}
