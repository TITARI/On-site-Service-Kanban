import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { createFileAppRepository, getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import { stripConfigSecrets } from "@/lib/services/config-service";
import type { StorageMode } from "@/lib/db/storage-mode";
import { authErrorResponse, resolveRequestActor } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

type BootstrapStorage = {
  mode: StorageMode;
  fallback: boolean;
  message?: string;
};

type BootstrapResult<T> =
  | { ok: true; data: T; storage?: BootstrapStorage }
  | { ok: false; status: number; payload: { message: string; storage: BootstrapStorage; details?: { primary?: string; fallback?: string } } };

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
  return { mode: "file", fallback: false, message: "使用 JSON 数据源启动。" };
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
      return {
        ok: true,
        data: await fallback(repository),
        storage: { mode: "file", fallback: true, message: "MariaDB 暂不可用，已使用 JSON 数据源启动。" }
      };
    } catch (fallbackError) {
      return {
        ok: false,
        status: 503,
        payload: {
          message: "数据源暂不可用",
          storage: { mode: "file", fallback: false, message: "MariaDB 暂不可用，JSON 数据源也加载失败。" },
          details: {
            primary: errorMessage(primaryError),
            fallback: errorMessage(fallbackError)
          }
        }
      };
    }
  }
}

function storagePayload(storage?: BootstrapStorage) {
  return storage ? { storage } : {};
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
    try {
      await resolveRequestActor(getAppRepository(), request, "mobile");
    } catch (error) {
      const response = authErrorResponse(error);
      return NextResponse.json({ message: response.message }, { status: response.status });
    }

    const result = await loadWithJsonFallback(
      async (repository) => {
        await repository.runAutoAcceptance();
        return repository.mobileBootstrap();
      },
      async (repository) => {
        await repository.runAutoAcceptance();
        return repository.mobileBootstrap();
      }
    );
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
