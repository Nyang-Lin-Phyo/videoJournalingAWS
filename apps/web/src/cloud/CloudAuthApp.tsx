import { AuthProvider, useAuth } from "react-oidc-context";
import type { AuthProviderProps } from "react-oidc-context";
import { CloudIngestApp } from "./CloudIngestApp";
import { useRef, useState } from "react";
import { LoginPage } from "./LoginPage";

const region = import.meta.env.VITE_COGNITO_REGION as string | undefined;
const poolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;

export function AuthenticatedCloud() {
  const auth = useAuth();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [signInError, setSignInError] = useState(false);
  const signInPending = useRef(false);
  async function signIn() {
    if (signInPending.current) return;
    signInPending.current = true;
    setIsRedirecting(true);
    setSignInError(false);
    try {
      await auth.signinRedirect({ extraQueryParams: { identity_provider: "Google" } });
    } catch {
      setSignInError(true);
    } finally {
      signInPending.current = false;
      setIsRedirecting(false);
    }
  }
  if (auth.isLoading || auth.activeNavigator || !auth.isAuthenticated) {
    return <LoginPage onSignIn={() => void signIn()}
      isLoading={auth.isLoading || Boolean(auth.activeNavigator) || isRedirecting}
      error={auth.error || signInError ? "We couldn’t complete sign-in. Please try again with Google." : undefined} />;
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
    <CloudIngestApp
      key={auth.user?.profile.sub ?? "anonymous"}
      accountEmail={auth.user?.profile.email}
      onSignOut={signOut}
      onAccountDeleted={signOut}
    />
  </>;
}

export function CloudAuthApp() {
  if (!region || !poolId || !clientId || !cognitoDomain) {
    return <LoginPage onSignIn={() => {}} disabled
      error="Sign-in isn’t available right now. Missing VITE_COGNITO_* configuration. Please contact the app maintainer." />;
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
