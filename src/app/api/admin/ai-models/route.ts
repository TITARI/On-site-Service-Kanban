import { NextResponse } from "next/server";
import { assertApiKeyEnv, validateAiEndpoint } from "@/lib/ai/endpoint-validation";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

type ModelListResponse = {
  data?: Array<{ id?: unknown }>;
  models?: unknown[];
};

type AiModelId = "fast" | "smart";

type AiModelsRequest = {
  endpoint?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
  modelId?: unknown;
};

function modelsEndpointFor(endpoint: string) {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path.replace(/\/chat\/completions$/i, "/models");
  } else if (/\/completions$/i.test(path)) {
    url.pathname = path.replace(/\/completions$/i, "/models");
  } else if (!/\/models$/i.test(path)) {
    url.pathname = `${path}/models`;
  }
  url.search = "";
  return url.toString();
}

function modelIdsFrom(data: ModelListResponse) {
  const candidates = data.data ?? data.models ?? [];
  return Array.from(new Set(candidates
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item && typeof item.id === "string") return item.id;
      return "";
    })
    .map((item) => item.trim())
    .filter(Boolean)));
}

function aiModelIdFrom(value: unknown): AiModelId | undefined {
  return value === "fast" || value === "smart" ? value : undefined;
}

async function savedApiKeyFor(modelId?: AiModelId, apiKeyEnvOverride?: string) {
  assertApiKeyEnv(apiKeyEnvOverride);
  if (apiKeyEnvOverride) return process.env[apiKeyEnvOverride]?.trim() ?? "";
  if (!modelId) return "";
  const config = await getAppRepository().getConfig();
  const model = config.aiModels.find((item) => item.id === modelId);
  const directApiKey = typeof model?.apiKey === "string" ? model.apiKey.trim() : "";
  if (directApiKey) return directApiKey;
  const apiKeyEnv = typeof model?.apiKeyEnv === "string" ? model.apiKeyEnv.trim() : "";
  assertApiKeyEnv(apiKeyEnv || undefined);
  return apiKeyEnv ? process.env[apiKeyEnv]?.trim() ?? "" : "";
}

export async function POST(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  let payload: AiModelsRequest;
  try {
    payload = await parseJson(request) as AiModelsRequest;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
  const requestApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const apiKeyEnv = typeof payload.apiKeyEnv === "string" ? payload.apiKeyEnv.trim() || undefined : undefined;

  const endpointValidation = validateAiEndpoint(endpoint);
  if (!endpointValidation.ok) return badRequest(endpointValidation.reason);

  try {
    assertApiKeyEnv(apiKeyEnv);
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  let apiKey = requestApiKey;
  if (!apiKey) {
    try {
      apiKey = await savedApiKeyFor(aiModelIdFrom(payload.modelId), apiKeyEnv);
    } catch (error) {
      return badRequest(errorMessage(error));
    }
  }
  if (!endpoint || !apiKey) return badRequest("请填写接口地址和接口密钥");

  let modelsEndpoint: string;
  try {
    modelsEndpoint = modelsEndpointFor(endpoint);
  } catch {
    return badRequest("智能接口地址不正确");
  }

  try {
    const response = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return badRequest(`模型列表接口异常：${response.status}`);
    const models = modelIdsFrom(await response.json() as ModelListResponse);
    if (models.length === 0) return badRequest("未获取到可用模型");
    return NextResponse.json({ models });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json({ message: "AI 端点响应超时" }, { status: 504 });
    }
    return NextResponse.json({ message: "AI 端点不可达" }, { status: 502 });
  }
}
