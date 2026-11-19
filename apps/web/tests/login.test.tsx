import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedCloud, CloudAuthApp } from "../src/cloud/CloudAuthApp";

const auth = vi.hoisted(() => ({
  isLoading: false,
  activeNavigator: undefined as string | undefined,
  isAuthenticated: false,
  error: undefined as Error | undefined,
  signinRedirect: vi.fn(),
  removeUser: vi.fn(),
  user: { profile: { email: "journal@example.com", sub: "test-user" } },
}));
vi.mock("react-oidc-context", () => ({ useAuth: () => auth }));
vi.mock("../src/cloud/CloudIngestApp", () => ({
  CloudIngestApp: () => <div>Your journal workspace</div>,
}));

beforeEach(() => {
  auth.isLoading = false;
  auth.activeNavigator = undefined;
  auth.isAuthenticated = false;
  auth.error = undefined;
  auth.signinRedirect.mockReset();
});

describe("login home page", () => {
  it("starts Google sign-in and prevents repeated clicks while redirecting", async () => {
    let finish!: () => void;
    auth.signinRedirect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<AuthenticatedCloud />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(auth.signinRedirect).toHaveBeenCalledExactlyOnceWith({ extraQueryParams: { identity_provider: "Google" } });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Opening your space");
    finish();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("offers a retry after a redirect failure without exposing internal errors", async () => {
    auth.signinRedirect.mockRejectedValue(new Error("internal provider details"));
    render(<AuthenticatedCloud />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please try again with Google");
    expect(screen.queryByText(/internal provider details/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("disables sign-in during session restoration and provider navigation", () => {
    auth.isLoading = true;
    const { rerender } = render(<AuthenticatedCloud />);
    expect(screen.getByRole("button")).toBeDisabled();
    auth.isLoading = false;
    auth.activeNavigator = "signinRedirect";
    rerender(<AuthenticatedCloud />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("keeps the login available after a provider callback error", () => {
    auth.error = new Error("callback failed");
    render(<AuthenticatedCloud />);
    expect(screen.getByRole("alert")).toHaveTextContent("Please try again");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("shows the workspace for an authenticated user", () => {
    auth.isAuthenticated = true;
    render(<AuthenticatedCloud />);
    expect(screen.getByText("Your journal workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });

  it("explains missing configuration and prevents an unusable sign-in", () => {
    render(<CloudAuthApp />);
    expect(screen.getByRole("alert")).toHaveTextContent("Missing VITE_COGNITO_* configuration");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
  });

  it("shows the workspace without the old top-right account bar once signed in", () => {
    auth.isAuthenticated = true;
    render(<AuthenticatedCloud />);
    expect(screen.getByText("Your journal workspace")).toBeVisible();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
