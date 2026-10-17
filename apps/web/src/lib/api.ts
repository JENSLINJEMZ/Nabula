/** Small typed fetch wrapper that mirrors the server's auth contract. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function getCsrfToken(): string | null {
  return readCookie("nebula_csrf");
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: { formData?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (mutating) {
    const token = getCsrfToken();
    if (token) headers["x-csrf-token"] = token;
  }

  let payload: BodyInit | undefined;
  if (options.formData) {
    payload = options.formData;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, { method, headers, body: payload, credentials: "include" });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed with status ${response.status}`,
      err?.details,
    );
  }
  return parsed as T;
}

export const apiGet = <T = unknown>(path: string) => api<T>("GET", path);
export const apiPost = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body);
export const apiPut = <T = unknown>(path: string, body?: unknown) => api<T>("PUT", path, body);
export const apiPatch = <T = unknown>(path: string, body?: unknown) => api<T>("PATCH", path, body);
export const apiDelete = <T = unknown>(path: string, body?: unknown) => api<T>("DELETE", path, body);
export const apiUpload = <T = unknown>(path: string, file: File) => {
  const formData = new FormData();
  formData.append("file", file, file.name);
  return api<T>("POST", path, undefined, { formData });
};
