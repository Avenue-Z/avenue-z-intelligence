import {BarChart3,FileText,Sparkles,ArrowUpRight} from 'lucide-react';
import {GoogleSignInButton} from './google-signin-button';
import styles from './sign-in-screen.module.css';

type SignInScreenProps={callbackUrl:string;provider?:'google'|'chatgpt';signInPath?:string;error?:string};

export function SignInScreen({callbackUrl,provider='google',signInPath,error}:SignInScreenProps){
 return <main className={styles.screen}>
  <header className={styles.header}>
   <a className={styles.brand} href="/" aria-label="Avenue Z Intelligence home"><span className={styles.mark} aria-hidden="true">Z</span><span>AVENUE Z<small>INTELLIGENCE</small></span></a>
   <span className={styles.teamLabel}>A workspace for the Avenue Z team</span>
  </header>
  <div className={styles.content}>
   <section className={styles.introduction} aria-labelledby="welcome-heading">
    <p className={styles.eyebrow}><span aria-hidden="true"/>THE BIG PICTURE. THE IMPORTANT DETAILS.</p>
    <h1 id="welcome-heading">Every client.<br/><span>One clear view.</span></h1>
    <p className={styles.description}>Performance, daily reviews, and the context behind the numbers. Together in one workspace.</p>
    <div className={styles.features} aria-label="Workspace features"><span><BarChart3 size={17} aria-hidden="true"/>Performance</span><span><FileText size={17} aria-hidden="true"/>Daily reviews</span><span><Sparkles size={17} aria-hidden="true"/>AI analyst</span></div>
   </section>
   <section className={styles.signIn} aria-labelledby="sign-in-heading">
    <div className={styles.cardMark} aria-hidden="true"><ArrowUpRight size={25}/></div>
    <p className={styles.cardEyebrow}>YOUR TEAM WORKSPACE</p>
    <h2 id="sign-in-heading">Welcome in.</h2>
    <p className={styles.cardDescription}>Your next decision starts here.</p>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    {provider==='google'?<GoogleSignInButton callbackUrl={callbackUrl} className={styles.googleButton}/>:<a className={styles.googleButton} href={signInPath} target="_top">Continue with ChatGPT<ArrowUpRight size={18} aria-hidden="true"/></a>}
    <p className={styles.accountNote}>{provider==='google'?<>Use your <strong>@avenuez.com</strong> Google account.</>:<>Sign in to access your team workspace.</>}</p>
    <div className={styles.cardFooter}><span aria-hidden="true"/>Shared intelligence. Better decisions.</div>
   </section>
  </div>
  <footer className={styles.footer}><span>AVENUE Z / INTELLIGENCE</span><span>See clearly. Move confidently.</span></footer>
 </main>;
}
