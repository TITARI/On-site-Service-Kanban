import type {
  AuthenticatedActor,
  BootstrapAdminInput,
  SessionType
} from "../domain/access-control";

export type SessionPayload =
  | { authenticated: true; user: AuthenticatedActor }
  | { authenticated: false; bootstrapRequired?: boolean };

async function responseMessage(response: Response) {
  try {
    return (await response.json() as { message?: string }).message;
  } catch {
    return undefined;
  }
}

export async function loadSession(type: SessionType): Promise<SessionPayload> {
  const response = await fetch(`/api/auth/session?type=${type}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "登录状态检查失败");
  return await response.json() as SessionPayload;
}

export async function loginMobile(input: { name: string; phone: string; groupId: string }) {
  const response = await fetch("/api/auth/mobile/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "登录失败");
  return await response.json() as { user: AuthenticatedActor };
}

export async function logoutMobile() {
  const response = await fetch("/api/auth/mobile/logout", { method: "POST" });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "退出登录失败");
}

export async function loginAdmin(input: { phone: string; password: string }) {
  const response = await fetch("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "登录失败");
  return await response.json() as { user: AuthenticatedActor };
}

export async function bootstrapAdmin(input: BootstrapAdminInput) {
  const response = await fetch("/api/admin/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "初始化失败");
  return await response.json() as { user: AuthenticatedActor };
}

export async function logoutAdmin() {
  const response = await fetch("/api/admin/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error(await responseMessage(response) ?? "退出登录失败");
}
