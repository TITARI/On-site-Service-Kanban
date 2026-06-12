import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { normalizeKeywordGroups } from "@/lib/domain/keyword-config";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";

const keywordRuleSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  matchType: z.enum(["contains", "exact"]),
  action: z.enum(["operational-intent", "issue-type"]),
  issueType: z.string().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true)
});

const keywordTermSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().optional()
});

const keywordRuleSetSchema = z.object({
  id: z.string().min(1),
  matchType: z.enum(["contains", "exact"]),
  action: z.enum(["operational-intent", "issue-type"]),
  issueType: z.string().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  channels: z.array(z.enum(["wechat", "wecom"])).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
  terms: z.array(keywordTermSchema).default([])
});

const keywordGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: z.boolean().default(true),
  ruleSets: z.array(keywordRuleSetSchema).optional(),
  rules: z.array(keywordRuleSchema).optional()
});

const payloadSchema = z.object({
  keywordGroups: z.array(keywordGroupSchema)
});

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const config = await getAppRepository().getConfig();
  return NextResponse.json({ keywordGroups: normalizeKeywordGroups(config.keywordGroups ?? []) });
}

export async function PUT(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof payloadSchema>;
  try {
    input = payloadSchema.parse(await parseJson(request));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const keywordGroups = await getAppRepository().saveKeywordGroups(normalizeKeywordGroups(input.keywordGroups));
  return NextResponse.json({ keywordGroups });
}
