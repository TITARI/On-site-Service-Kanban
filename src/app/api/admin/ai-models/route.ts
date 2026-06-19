import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

type ModelListResponse = {
  data?: Array<{ id?: unknown }>;
  models?: unknown[];
};

type AiModelId = "fast" | "smart";

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

async function savedApiKeyFor(modelId?: AiModelId) {
  if (!modelId) return "";
  const config = await getAppRepository().getConfig();
  const model = config.aiModels.find((item) => item.id === modelId);
  const directApiKey = typeof model?.apiKey === "string" ? model.apiKey.trim() : "";
  if (directApiKey) return directApiKey;
  const apiKeyEnv = typeof model?.apiKeyEnv === "string" ? model.apiKeyEnv.trim() : "";
  return apiKeyEnv ? process.env[apiKeyEnv]?.trim() ?? "" : "";
}

export async function POST(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  let payload: { endpoint?: unknown; apiKey?: unknown; modelId?: unknown };
  try {
    payload = await parseJson(request) as { endpoint?: unknown; apiKey?: unknown; modelId?: unknown };
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
  const requestApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  let apiKey = requestApiKey;
  if (!apiKey) {
    try {
      apiKey = await savedApiKeyFor(aiModelIdFrom(payload.modelId));
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
      cache: "no-store"
    });
    if (!response.ok) return badRequest(`模型列表接口异常：${response.status}`);
    const models = modelIdsFrom(await response.json() as ModelListResponse);
    if (models.length === 0) return badRequest("未获取到可用模型");
    return NextResponse.json({ models });
  } catch {
    return badRequest("模型列表获取失败，请检查接口地址和网络");
  }
}
