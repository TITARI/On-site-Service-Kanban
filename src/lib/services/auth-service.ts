import { NextResponse } from "next/server";
import type { PermissionCode, SessionType } from "../domain/access-control";
import { getAppRepository, type AppRepository } from "../repositories/app-repository";
import { userGroupsOf } from "../seed";
import {
  createSessionToken,
  requestSessionToken,
  sessionCookie,
  sessionTokenHash
} from "./session-service";

export type MobileLoginInput = {
  name: string;
  phone: string;
  groupId: string;
};

const MOBILE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

export async function mobileLogin(
  repository: AppRepository,
  input: MobileLoginInput,
  now = new Date()
) {
  const name = input.name.trim();
  const phone = normalizePhone(input.phone);
  if (!name) throw new Error("真实姓名不能为空");
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("手机号格式不正确");
  const config = await repository.getConfig();
  if (!userGroupsOf(config).some((group) => group.id === input.groupId && group.enabled)) {
    throw new Error("用户分组不存在或已停用");
  }

  const { actor } = await repository.upsertMobileAccount({
    name,
    phone,
    groupId: input.groupId
  });
  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + MOBILE_SESSION_MS);
  await repository.createAccountSession(
    actor.accountId,
    "mobile",
    sessionTokenHash(token),
    expiresAt.toISOString()
  );
  return {
    actor,
    token,
    expiresAt,
    cookie: sessionCookie("mobile", token, expiresAt)
  };
}

export async function resolveRequestActor(
  repository: AppRepository,
  request: Request,
  type: SessionType,
  requiredPermission?: PermissionCode
) {
  const token = requestSessionToken(request, type);
  if (!token) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "未登录" }, { status: 401 })
    };
  }
  const resolution = await repository.resolveAccountSession(sessionTokenHash(token), type);
  if (!resolution) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "登录状态已失效" }, { status: 401 })
    };
  }
  if (requiredPermission && !resolution.actor.permissions.includes(requiredPermission)) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "没有执行该操作的权限" }, { status: 403 })
    };
  }
  return { ok: true as const, actor: resolution.actor, session: resolution.session };
}

export async function requireRequestActor(
  request: Request,
  type: SessionType,
  requiredPermission: PermissionCode | undefined,
  repository: AppRepository = getAppRepository()
) {
  return resolveRequestActor(repository, request, type, requiredPermission);
}
