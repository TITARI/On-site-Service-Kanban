import { AUTH_STORAGE_KEY, type CurrentUser } from "@/lib/client/auth";

export async function resolveMobileSession(): Promise<CurrentUser | null> {
  const response = await fetch("/api/auth/session?type=mobile", {
    cache: "no-store"
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Session check failed");
  const payload = await response.json() as { user?: CurrentUser };
  return payload.user ?? null;
}

export function removeLegacyStoredUser() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}
