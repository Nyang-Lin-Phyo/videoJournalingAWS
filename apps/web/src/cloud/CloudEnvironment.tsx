import { createContext, useContext } from "react";
import { AuthContext } from "react-oidc-context";
import * as api from "./analysisApi";
import { uploadMp4 } from "./uploadToS3";

export const cloudServices = { ...api, uploadMp4 };
export type CloudEnvironment = {
  userSub: string;
  accessToken: string;
  services: typeof cloudServices;
};

// Local previews supply data here while rendering the same cloud components.
// The deployed app derives its session from the real Cognito provider.
export const CloudEnvironmentContext = createContext<CloudEnvironment | null>(null);

export function useCloudEnvironment(): CloudEnvironment {
  const override = useContext(CloudEnvironmentContext);
  const auth = useContext(AuthContext);
  return override ?? {
    userSub: auth?.user?.profile.sub ?? "",
    accessToken: auth?.user?.access_token ?? "",
    services: cloudServices,
  };
}
