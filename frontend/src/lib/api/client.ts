// --- Fetch client ---

const BASE = "/api";

// Carries the HTTP status alongside the message so callers can distinguish, e.g., a 404
// for "this row doesn't exist yet" (a legitimate not-yet-synced state) from a real failure.
export class ApiError extends Error {
  status: number;
  operationId?: string;
  syncId?: number;
  code?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      operationId?: string;
      syncId?: number;
      code?: string;
    },
  ) {
    super(message);
    this.status = status;
    this.operationId = options?.operationId;
    this.syncId = options?.syncId;
    this.code = options?.code;
  }
}

export function isNotFoundError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 404;
}

export function deletionOperationIdFromError(err: unknown): string | null {
  return err instanceof ApiError &&
      typeof err.operationId === "string" &&
      err.operationId.length > 0
    ? err.operationId
    : null;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
      operationId?: unknown;
      syncId?: unknown;
      code?: unknown;
    };
    const message = body.error ?? res.statusText;
    const operationId = typeof body.operationId === "string" && body.operationId.length > 0
      ? body.operationId
      : undefined;
    throw new ApiError(res.status, message.charAt(0).toUpperCase() + message.slice(1), {
      operationId,
      syncId: typeof body.syncId === "number" ? body.syncId : undefined,
      code: typeof body.code === "string" ? body.code : undefined,
    });
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
