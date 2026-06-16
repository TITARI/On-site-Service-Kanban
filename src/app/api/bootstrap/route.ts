import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { createFileAppRepository, getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import { stripConfigSecrets } from "@/lib/services/config-service";
import type { StorageMode } from "@/lib/db/storage-mode";
import { AuthError, resolveRequestActor } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

type BootstrapStorage = {
  mode: StorageMode;
  fallback: boolean;
  message?: string;
};

type BootstrapErrorPayload = {
  message: string;
  storage?: BootstrapStorage;
  details?: { primary?: string; fallback?: string };
};

type BootstrapResult<T> =
  | { ok: true; data: T; storage?: BootstrapStorage }
  | { ok: false; status: number; payload: BootstrapErrorPayload };

const DEGRADED_MESSAGE = "\u6570\u636e\u6e90\u6682\u4e0d\u53ef\u7528";

const RECOVERABLE_DATABASE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_NO_SUCH_TABLE"
]);

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableDatabaseError(error: unknown) {
  const code = errorCode(error);
  if (code && RECOVERABLE_DATABASE_CODES.has(code)) return true;
  return /DATABASE_URL|connect|connection|access denied|unknown database|table .* doesn't exist/i.test(errorMessage(error));
}

function successStorage(repository: AppRepository): BootstrapStorage | undefined {
  if (repository.kind !== "file") return undefined;
  return { mode: "file", fallback: false, message: "\u4f7f\u7528 JSON \u6570\u636e\u6e90\u542f\u52a8\u3002" };
}

function fallbackStorage(): BootstrapStorage {
  return {
    mode: "file",
    fallback: true,
    message: "MariaDB \u6682\u4e0d\u53ef\u7528\uff0c\u5df2\u4f7f\u7528 JSON \u6570\u636e\u6e90\u542f\u52a8\u3002"
  };
}

function failedFallbackPayload(primaryError: unknown, fallbackError: unknown): BootstrapErrorPayload {
  return {
    message: DEGRADED_MESSAGE,
    storage: {
      mode: "file",
      fallback: false,
      message: "MariaDB \u6682\u4e0d\u53ef\u7528\uff0cJSON \u6570\u636e\u6e90\u4e5f\u52a0\u8f7d\u5931\u8d25\u3002"
    },
    details: {
      primary: errorMessage(primaryError),
      fallback: errorMessage(fallbackError)
    }
  };
}

async function loadWithJsonFallback<T>(
  primary: (repository: AppRepository) => Promise<T>,
  fallback: (repository: AppRepository) => Promise<T>
): Promise<BootstrapResult<T>> {
  try {
    const repository = getAppRepository();
    return { ok: true, data: await primary(repository), storage: successStorage(repository) };
  } catch (primaryError) {
    if (!isRecoverableDatabaseError(primaryError)) throw primaryError;

    try {
      const repository = createFileAppRepository();
      return { ok: true, data: await fallback(repository), storage: fallbackStorage() };
    } catch (fallbackError) {
      return { ok: false, status: 503, payload: failedFallbackPayload(primaryError, fallbackError) };
    }
  }
}

function storagePayload(storage?: BootstrapStorage) {
  return storage ? { storage } : {};
}

function authFailure(error: AuthError): BootstrapResult<never> {
  return { ok: false, status: error.status, payload: { message: error.message } };
}

async function loadMobileWithJsonFallback(request: Request): Promise<BootstrapResult<Awaited<ReturnType<AppRepository["mobileBootstrap"]>>>> {
  try {
    const repository = getAppRepository();
    await resolveRequestActor(repository, request, "mobile");
    await repository.runAutoAcceptance();
    return { ok: true, data: await repository.mobileBootstrap(), storage: successStorage(repository) };
  } catch (primaryError) {
    if (primaryError instanceof AuthError) return authFailure(primaryError);
    if (!isRecoverableDatabaseError(primaryError)) throw primaryError;

    try {
      const repository = createFileAppRepository();
      await resolveRequestActor(repository, request, "mobile");
      await repository.runAutoAcceptance();
      return { ok: true, data: await repository.mobileBootstrap(), storage: fallbackStorage() };
    } catch (fallbackError) {
      if (fallbackError instanceof AuthError) return authFailure(fallbackError);
      return { ok: false, status: 503, payload: failedFallbackPayload(primaryError, fallbackError) };
    }
  }
}

export async function GET(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope");
  if (scope === "login") {
    const result = await loadWithJsonFallback(
      (repository) => repository.getConfig(),
      (repository) => repository.getConfig()
    );
    if (!result.ok) return NextResponse.json(result.payload, { status: result.status });
    const config = result.data;
    return NextResponse.json({
      config: stripConfigSecrets(config),
      ...storagePayload(result.storage)
    });
  }

  if (scope === "mobile") {
    const result = await loadMobileWithJsonFallback(request);
    if (!result.ok) return NextResponse.json(result.payload, { status: result.status });
    const data = result.data;
    return NextResponse.json({
      tickets: data.tickets,
      config: stripConfigSecrets(data.config),
      ...storagePayload(result.storage)
    });
  }

  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  const result = await loadWithJsonFallback(
    async (repository) => {
      await repository.runAutoAcceptance();
      return repository.adminBootstrap();
    },
    async (repository) => {
      await repository.runAutoAcceptance();
      return repository.adminBootstrap();
    }
  );
  if (!result.ok) return NextResponse.json(result.payload, { status: result.status });
  const state = result.data;
  return NextResponse.json({
    tickets: state.tickets,
    booths: state.booths,
    messageRecords: state.messageRecords,
    people: state.people ?? [],
    chatIdentities: state.chatIdentities ?? [],
    conversations: state.conversations ?? [],
    pendingWorkOrderSessions: state.pendingWorkOrderSessions ?? [],
    outboundMessages: state.outboundMessages ?? [],
    config: stripConfigSecrets(state.config),
    ...storagePayload(result.storage)
  });
}
