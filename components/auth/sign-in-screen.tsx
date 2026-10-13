import {BarChart3,FileText,MessageCircle,ArrowUpRight} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import {GoogleSignInButton} from './google-signin-button';
import styles from './sign-in-screen.module.css';

type SignInScreenProps={callbackUrl:string;provider?:'google'|'chatgpt';signInPath?:string;error?:string};

export function SignInScreen({callbackUrl,provider='google',signInPath,error}:SignInScreenProps){
 return <main className={styles.screen}>
  <header className={styles.header}>
   <Link className={styles.brand} href="/" aria-label="Avenue Z Intelligence home"><Image src="/brand/avenue-z-white.svg" width={147} height={31} alt="Avenue Z" unoptimized/><span>INTELLIGENCE</span></Link>
   <span className={styles.teamLabel}>A workspace for the Avenue Z team</span>
  </header>
  <div className={styles.content}>
   <section className={styles.introduction} aria-labelledby="welcome-heading">
    <p className={styles.eyebrow}>THE AVENUE Z ANALYTICS WORKSPACE</p>
    <h1 id="welcome-heading">Every client.<br/><span>One clear view.</span></h1>
    <p className={styles.description}>Performance, daily reviews, and the context behind the numbers. Together in one workspace.</p>
    <div className={styles.features} aria-label="Workspace features"><span><BarChart3 size={17} aria-hidden="true"/>Performance</span><span><FileText size={17} aria-hidden="true"/>Daily reviews</span><span><MessageCircle size={17} aria-hidden="true"/>AI analyst</span></div>
   </section>
   <section className={styles.signIn} aria-labelledby="sign-in-heading">
    <p className={styles.cardEyebrow}>YOUR TEAM WORKSPACE</p>
    <h2 id="sign-in-heading">Welcome in.</h2>
    <p className={styles.cardDescription}>Sign in to your shared client intelligence.</p>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    {provider==='google'?<GoogleSignInButton callbackUrl={callbackUrl} className={styles.googleButton}/>:<a className={styles.googleButton} href={signInPath} target="_top">Continue with ChatGPT<ArrowUpRight size={18} aria-hidden="true"/></a>}
    <p className={styles.accountNote}>{provider==='google'?<>Use your <strong>@avenuez.com</strong> Google account.</>:<>Sign in to access your team workspace.</>}</p>
    <div className={styles.cardFooter}>Your company account. Your team workspace.</div>
   </section>
  </div>
  <footer className={styles.footer}><span>AVENUE Z / INTELLIGENCE</span><span>Performance. Context. Decisions.</span></footer>
 </main>;
}
