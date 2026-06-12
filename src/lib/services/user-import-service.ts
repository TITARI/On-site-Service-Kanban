import { randomUUID } from "node:crypto";
import {
  isUserImportDecision,
  parseUserImportRows,
  type UserImportDecision,
  type UserImportJob,
  type UserImportRow
} from "../domain/user-import";
import type { AuthenticatedActor } from "../domain/access-control";
import type { AppRepository } from "../repositories/app-repository";

export class UserImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UserImportError";
  }
}

type PreviewInput = {
  sourceName?: unknown;
  sourceHash?: unknown;
  rows?: unknown;
};

function inputObject(value: unknown): PreviewInput {
  return value && typeof value === "object" ? value as PreviewInput : {};
}

async function exactUserByPhone(repository: AppRepository, phone: string) {
  if (!phone) return undefined;
  const result = await repository.listUsers({
    search: phone,
    page: 1,
    pageSize: 10
  });
  return result.users.find((user) => user.phone === phone);
}

export async function previewUserImport(
  repository: AppRepository,
  input: unknown,
  actor: AuthenticatedActor
) {
  const payload = inputObject(input);
  const sourceName = typeof payload.sourceName === "string" ? payload.sourceName.trim() : "";
  const sourceHash = typeof payload.sourceHash === "string" ? payload.sourceHash.trim().toLowerCase() : "";
  if (!sourceName) throw new UserImportError("导入文件名不能为空");
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new UserImportError("导入文件哈希无效");
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new UserImportError("导入文件没有用户数据");
  }
  if (payload.rows.length > 5000) throw new UserImportError("单次最多导入 5000 位用户");

  const config = await repository.getConfig();
  const parsed = parseUserImportRows(payload.rows, config.userGroups ?? []);
  const rows: UserImportRow[] = [];
  for (const parsedRow of parsed.rows) {
    const existingUser = await exactUserByPhone(repository, parsedRow.normalized.phone);
    const wechatIdentity = parsedRow.normalized.wechatExternalUserId
      ? await repository.identityByExternalId("wechat", parsedRow.normalized.wechatExternalUserId)
      : undefined;
    const wecomIdentity = parsedRow.normalized.wecomExternalUserId
      ? await repository.identityByExternalId("wecom", parsedRow.normalized.wecomExternalUserId)
      : undefined;
    const conflicts: string[] = [];
    if (existingUser) conflicts.push("phone-exists");
    if (wechatIdentity?.personId && wechatIdentity.personId !== existingUser?.personId) {
      conflicts.push("wechat-occupied");
    }
    if (wecomIdentity?.personId && wecomIdentity.personId !== existingUser?.personId) {
      conflicts.push("wecom-occupied");
    }
    rows.push({
      id: `import-row-${randomUUID()}`,
      ...parsedRow,
      conflicts,
      allowedActions: parsedRow.errors.length > 0
        ? ["skip"]
        : existingUser
          ? ["overwrite", "skip"]
          : ["add", "skip"],
      snapshot: {
        ...(existingUser ? {
          existingUser: {
            personId: existingUser.personId,
            updatedAt: existingUser.updatedAt
          }
        } : {}),
        ...(wechatIdentity ? {
          wechatIdentity: {
            id: wechatIdentity.id,
            personId: wechatIdentity.personId,
            lastSeenAt: wechatIdentity.lastSeenAt
          }
        } : {}),
        ...(wecomIdentity ? {
          wecomIdentity: {
            id: wecomIdentity.id,
            personId: wecomIdentity.personId,
            lastSeenAt: wecomIdentity.lastSeenAt
          }
        } : {})
      }
    });
  }

  const now = new Date().toISOString();
  const job: UserImportJob = {
    id: `import-job-${randomUUID()}`,
    type: "people",
    ownerAccountId: actor.accountId,
    sourceName,
    sourceHash,
    previewVersion: `preview-${randomUUID()}`,
    status: "preview",
    createdAt: now,
    updatedAt: now,
    rows
  };
  return await repository.saveUserImportPreview(job);
}

type DecisionUpdate = {
  rowId?: unknown;
  decision?: unknown;
};

export async function saveUserImportDecisions(
  repository: AppRepository,
  jobId: string,
  input: unknown,
  actor: AuthenticatedActor
) {
  const job = await repository.loadUserImportJob(jobId);
  if (!job || job.ownerAccountId !== actor.accountId) {
    throw new UserImportError("导入预览不存在", 404);
  }
  if (job.status !== "preview") throw new UserImportError("导入预览已不能修改", 409);
  const payload = input && typeof input === "object"
    ? input as { rows?: unknown }
    : {};
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new UserImportError("没有需要保存的行决策");
  }

  const updates: Array<{ rowId: string; decision: UserImportDecision }> = [];
  for (const value of payload.rows as DecisionUpdate[]) {
    const rowId = typeof value.rowId === "string" ? value.rowId : "";
    const row = job.rows.find((item) => item.id === rowId);
    if (!row) throw new UserImportError("导入行不存在", 404);
    if (!isUserImportDecision(value.decision)) throw new UserImportError("导入行决策无效");
    if (!row.allowedActions.includes(value.decision.action)) {
      throw new UserImportError(`第 ${row.rowNumber} 行不允许执行该操作`);
    }
    updates.push({ rowId, decision: value.decision });
  }
  return await repository.updateUserImportDecisions(job.id, actor.accountId, updates);
}

export async function getUserImportJob(
  repository: AppRepository,
  jobId: string,
  actor: AuthenticatedActor
) {
  const job = await repository.loadUserImportJob(jobId);
  if (!job || job.ownerAccountId !== actor.accountId) {
    throw new UserImportError("导入预览不存在", 404);
  }
  return job;
}

export async function commitUserImport(
  repository: AppRepository,
  jobId: string,
  actor: AuthenticatedActor
) {
  const job = await getUserImportJob(repository, jobId, actor);
  if (job.status !== "preview") throw new UserImportError("导入预览已不能提交", 409);
  const undecided = job.rows.filter((row) => row.errors.length === 0 && !row.decision);
  if (undecided.length > 0) throw new UserImportError("请先为所有可处理行选择导入操作");
  if (!job.rows.some((row) => row.decision && row.decision.action !== "skip")) {
    throw new UserImportError("没有选择需要导入的用户");
  }
  const result = await repository.applyUserImport(job.id, actor.accountId, actor);
  if (result.stale) {
    throw new UserImportError("导入数据已变化，请重新处理冲突", 409);
  }
  return result.job;
}

export function userImportErrorStatus(error: unknown) {
  return error instanceof UserImportError ? error.status : 400;
}
