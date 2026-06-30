export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function responseErrorMessage(response: Response, fallback: string) {
  const text = await response.text();
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    return text;
  }

  return text || fallback;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new ApiRequestError(response.status, await responseErrorMessage(response, fallback));
  }
  return response;
}

export async function apiJson<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await apiFetch(input, init, fallback);
  return await response.json() as T;
}

export function isUnauthorized(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 401;
}
