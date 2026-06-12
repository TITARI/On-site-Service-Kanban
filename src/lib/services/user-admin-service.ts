import { z } from "zod";
import type {
  AuthenticatedActor,
  UserListItem,
  UserQuery
} from "../domain/access-control";
import type { AppRepository } from "../repositories/app-repository";
import { hashPassword } from "./password-service";

export class UserAdminError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UserAdminError";
  }
}

export const userMutationSchema = z.object({
  name: z.string().trim().min(1, "姓名不能为空").max(120),
  phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
  groupId: z.string().trim().min(1, "用户分组不能为空").max(64),
  groupLocked: z.boolean(),
  enabled: z.boolean()
});

const userUpdateSchema = userMutationSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  "没有需要保存的用户信息"
);

const passwordSchema = z.string().min(10, "后台密码至少需要10位").max(1024);

function normalizePhone(value: unknown) {
  return typeof value === "string" ? value.replace(/\D/g, "") : value;
}

function normalizeMutation(input: unknown) {
  if (!input || typeof input !== "object") return input;
  const value = input as Record<string, unknown>;
  return { ...value, phone: normalizePhone(value.phone) };
}

function translateRepositoryError(error: unknown): never {
  const message = error instanceof Error ? error.message : "用户操作失败";
  if (/not found|不存在/i.test(message)) throw new UserAdminError("用户不存在", 404);
  if (/already assigned|已被其他用户使用|duplicate/i.test(message)) {
    throw new UserAdminError("手机号已被其他用户使用", 409);
  }
  if (/必须保留至少一位可用后台管理员|已有历史记录，仅可停用/.test(message)) {
    throw new UserAdminError(message, 409);
  }
  if (/group|分组|mobile|手机号/i.test(message)) throw new UserAdminError(message, 400);
  throw error;
}

async function existingUser(repository: AppRepository, userId: string) {
  const user = await repository.getUser(userId);
  if (!user) throw new UserAdminError("用户不存在", 404);
  return user;
}

function isUsableAdmin(user: UserListItem) {
  return user.enabled
    && user.hasPassword
    && user.permissions.includes("admin.access");
}

async function ensureAdminRemains(
  repository: AppRepository,
  current: UserListItem,
  remainsUsable: boolean
) {
  if (isUsableAdmin(current) && !remainsUsable && await repository.usableAdminCount() <= 1) {
    throw new UserAdminError("必须保留至少一位可用后台管理员", 409);
  }
}

async function enabledGroup(repository: AppRepository, groupId: string) {
  const config = await repository.getConfig();
  const group = config.userGroups?.find((item) => item.id === groupId && item.enabled);
  if (!group) throw new UserAdminError("用户分组不存在或已停用", 400);
  return group;
}

export async function listUsers(repository: AppRepository, query: UserQuery) {
  return await repository.listUsers(query);
}

export async function getUser(repository: AppRepository, userId: string) {
  return await existingUser(repository, userId);
}

export async function createUser(
  repository: AppRepository,
  input: unknown,
  actor: AuthenticatedActor
) {
  const parsed = userMutationSchema.safeParse(normalizeMutation(input));
  if (!parsed.success) throw new UserAdminError(parsed.error.issues[0]?.message ?? "用户信息无效", 400);
  await enabledGroup(repository, parsed.data.groupId);
  try {
    return await repository.createUser(parsed.data, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export async function updateUser(
  repository: AppRepository,
  userId: string,
  input: unknown,
  actor: AuthenticatedActor
) {
  const parsed = userUpdateSchema.safeParse(normalizeMutation(input));
  if (!parsed.success) throw new UserAdminError(parsed.error.issues[0]?.message ?? "用户信息无效", 400);
  const current = await existingUser(repository, userId);
  const group = parsed.data.groupId
    ? await enabledGroup(repository, parsed.data.groupId)
    : await enabledGroup(repository, current.groupId);
  const nextEnabled = parsed.data.enabled ?? current.enabled;
  await ensureAdminRemains(
    repository,
    current,
    Boolean(nextEnabled && current.hasPassword && group.canAdmin)
  );
  try {
    return await repository.updateUser(userId, parsed.data, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export async function disableUser(
  repository: AppRepository,
  userId: string,
  actor: AuthenticatedActor
) {
  const current = await existingUser(repository, userId);
  await ensureAdminRemains(repository, current, false);
  try {
    return await repository.setUserEnabled(userId, false, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export async function enableUser(
  repository: AppRepository,
  userId: string,
  actor: AuthenticatedActor
) {
  await existingUser(repository, userId);
  try {
    return await repository.setUserEnabled(userId, true, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export async function deleteUser(
  repository: AppRepository,
  userId: string,
  actor: AuthenticatedActor
) {
  const current = await existingUser(repository, userId);
  await ensureAdminRemains(repository, current, false);
  const history = await repository.userDeletionHistory(userId);
  if (!history.deletable) {
    throw new UserAdminError("该用户已有历史记录，仅可停用", 409);
  }
  try {
    await repository.deleteUser(userId, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export async function setUserPassword(
  repository: AppRepository,
  userId: string,
  password: unknown,
  actor: AuthenticatedActor
) {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new UserAdminError(parsed.error.issues[0]?.message ?? "后台密码无效", 400);
  const current = await existingUser(repository, userId);
  if (!current.permissions.includes("admin.access")) {
    throw new UserAdminError("仅拥有后台权限的用户可以设置后台密码", 400);
  }
  const passwordHash = await hashPassword(parsed.data);
  try {
    await repository.setUserPassword(userId, passwordHash, actor);
  } catch (error) {
    translateRepositoryError(error);
  }
}

export function userAdminErrorStatus(error: unknown) {
  return error instanceof UserAdminError ? error.status : 400;
}
