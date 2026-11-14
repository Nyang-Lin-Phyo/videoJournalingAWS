import { validateVideo } from "../api/validation";

export interface SignedUpload {
  upload_id: string;
  object_key: string;
  max_bytes: number;
  expires_in: number;
  upload: {
    method: "POST";
    url: string;
    fields: Record<string, string>;
  };
}

const configuredUrl = import.meta.env.VITE_INGEST_API_URL as string | undefined;

function assertSignedUpload(value: unknown): asserts value is SignedUpload {
  if (typeof value !== "object" || value === null) throw new Error("Unexpected upload API response.");
  const payload = value as Partial<SignedUpload>;
  if (!payload.upload_id || !payload.object_key || payload.upload?.method !== "POST" ||
      typeof payload.upload?.url !== "string" ||
      !payload.upload.fields || typeof payload.upload.fields !== "object" ||
      !Object.values(payload.upload.fields).every(x => typeof x === "string")) {
    throw new Error("Upload API response is missing required fields.");
  }
  const signedUrl = new URL(payload.upload.url);
  if (signedUrl.protocol !== "https:" || !signedUrl.hostname.endsWith(".amazonaws.com")) {
    throw new Error("Unexpected S3 upload destination.");
  }
}

export async function signUpload(file: File, title: string, accessToken: string, signal?: AbortSignal): Promise<SignedUpload> {
  const invalid = validateVideo(file);
  if (invalid) throw new Error(invalid);
  if (!configuredUrl) throw new Error("VITE_INGEST_API_URL is not configured in the frontend build.");
  const api = configuredUrl.replace(/\/$/, "");
  const response = await fetch(`${api}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
    body: JSON.stringify({ filename: file.name, content_type: "video/mp4", size: file.size, title: title.trim() }),
    signal,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data &&
      typeof data.error === "string" ? data.error : `Upload signing failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  assertSignedUpload(data);
  return data;
}

export function postToS3(
  signed: SignedUpload,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    for (const [key, value] of Object.entries(signed.upload.fields)) form.append(key, value);
    // The file MUST come after all S3 policy fields.
    form.append("file", file, file.name);
    xhr.open("POST", signed.upload.url);
    const abort = () => xhr.abort();
    if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.timeout = 120_000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded * 100 / event.total)));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    xhr.onload = () => {
      cleanup();
      if (xhr.status === 201 || xhr.status === 204) { onProgress(100); resolve(); }
      else reject(new Error(`S3 rejected the upload (HTTP ${xhr.status}). Check CORS, expiry and size.`));
    };
    xhr.onerror = () => { cleanup(); reject(new Error("Network error uploading to S3. Check connectivity and S3 CORS.")); };
    xhr.ontimeout = () => { cleanup(); reject(new Error("S3 upload timed out.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    xhr.send(form);
  });
}

export async function uploadMp4(
  file: File,
  title: string,
  onStage: (stage: "signing" | "uploading") => void,
  onProgress: (percent: number) => void,
  accessToken: string,
  signal?: AbortSignal,
) {
  onStage("signing");
  const signed = await signUpload(file, title, accessToken, signal);
  onStage("uploading");
  await postToS3(signed, file, onProgress, signal);
  return { upload_id: signed.upload_id, object_key: signed.object_key };
}
