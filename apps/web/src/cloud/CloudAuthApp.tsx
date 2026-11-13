import { AuthProvider, useAuth } from "react-oidc-context";
import type { AuthProviderProps } from "react-oidc-context";
import { CloudIngestApp } from "./CloudIngestApp";

const region = import.meta.env.VITE_COGNITO_REGION as string | undefined;
const poolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;

function AuthenticatedCloud() {
  const auth = useAuth();
  if (auth.isLoading || auth.activeNavigator) return <main style={{ padding: 32 }}>Loading Google sign-in…</main>;
  if (auth.error) return <main style={{ padding: 32 }} role="alert">Sign-in error: {auth.error.message}</main>;
  if (!auth.isAuthenticated) {
    return <main style={{ maxWidth: 520, margin: "70px auto", padding: 32 }}>
      <h1>reverie.</h1><p>A little space for yourself.</p>
      <button className="button button-primary" onClick={() => void auth.signinRedirect({ extraQueryParams: { identity_provider: "Google" } })}>
        Continue with Google
      </button>
      <p>Use fictional recordings until the full backend authorization tests pass.</p>
    </main>;
  }
  async function signOut() {
    // Remove this browser's session before redirecting to Cognito's logout endpoint.
    await auth.removeUser();
    if (!cognitoDomain || !clientId) return;
    const callback = encodeURIComponent(window.location.origin + "/");
    window.location.assign(`${cognitoDomain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${callback}`);
  }
  return <>
    <div style={{ padding: "8px 20px", display: "flex", justifyContent: "flex-end", gap: 16, alignItems: "center" }}>
      <span>Signed in as {auth.user?.profile.email ?? "Google user"}</span>
      <button type="button" onClick={() => void signOut()}>Sign out</button>
    </div>
    <CloudIngestApp />
  </>;
}

export function CloudAuthApp() {
  if (!region || !poolId || !clientId || !cognitoDomain) {
    return <main style={{ padding: 32 }} role="alert">Missing VITE_COGNITO_* configuration.</main>;
  }
  const oidcConfig: AuthProviderProps = {
    authority: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
    client_id: clientId,
    redirect_uri: `${window.location.origin}/`,
    response_type: "code",
    scope: "openid email profile",
    onSigninCallback: () => window.history.replaceState({}, document.title, window.location.pathname),
  };
  return <AuthProvider {...oidcConfig}><AuthenticatedCloud /></AuthProvider>;
}
