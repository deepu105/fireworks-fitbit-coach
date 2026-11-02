import { Dashboard } from "@/components/dashboard";
import { getAuth0 } from "@/lib/auth0";
import { ConfigurationError, getAuth0Config } from "@/lib/config";
import { mockHealthEnabled } from "@/lib/fitbit/environment";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let setupError: string | undefined;
  let name: string | undefined;
  let signedIn = false;
  try {
    getAuth0Config();
    const session = await getAuth0().getSession();
    signedIn = Boolean(session);
    name = session?.user.given_name ?? session?.user.name ?? "Signed in";
  } catch (error) {
    setupError = error instanceof ConfigurationError ? error.message : "The session could not be read. Try signing in again.";
  }
  const parameters = await searchParams;
  return (
    <main className="shell">
      <header className="header">
        <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">dw</span>Daily Wellbeing</a>
        <div className="account">{signedIn ? <><span>{name}</span><a className="button secondary" href="/auth/logout">Sign out</a></> :
          !setupError && <a className="button secondary" href="/auth/login">Sign in</a>}</div>
      </header>
      <section className="intro">
        <p className="eyebrow">Your daily Fitbit review</p>
        <h1>Review your day.<br />Choose what to do today.</h1>
        <p>See your activity, sleep, and resting heart rate, with suggestions based on your recent data.</p>
      </section>
      {mockHealthEnabled() && <p className="notice" role="status"><strong>Test data:</strong> These generated readings are for testing. Suggestions use Fireworks.</p>}
      {parameters.auth_error && <p className="notice error" role="alert">Sign-in or Fitbit connection failed. Try again, or check the connection settings in the README.</p>}
      {setupError ? <section className="welcome card">
        <h2>Configure the sample</h2><p>{setupError}</p>
        <p>Copy <code>.env.example</code> to <code>.env.local</code>, follow the README, and restart the server.</p>
      </section> : signedIn ? <Dashboard fixtureData={mockHealthEnabled()} /> : <section className="welcome card">
        <p className="eyebrow">Get started</p>
        <h2>Connect your Fitbit data</h2>
        <p>Sign in, connect Fitbit, and review your daily summary. You choose when to send it to Fireworks for suggestions.</p>
        <a className="button primary" href="/auth/login">Sign in with Auth0 <span aria-hidden="true">↗</span></a>
        <ol className="steps"><li><b>1</b><span>Sign in</span></li><li><b>2</b><span>Connect Fitbit</span></li><li><b>3</b><span>Review your day</span></li></ol>
      </section>}
      <footer>
        <p>Suggestions use wearable estimates and are for general wellbeing. They do not diagnose or treat health conditions.</p>
        <p>Fitbit data · Auth0 · Fireworks</p>
      </footer>
    </main>
  );
}
