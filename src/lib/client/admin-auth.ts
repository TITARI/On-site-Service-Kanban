export const ADMIN_AUTH_STORAGE_KEY = "internal-board-admin-session";

export function readAdminSession() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ADMIN_AUTH_STORAGE_KEY) === "active";
}

export function storeAdminSession() {
  window.localStorage.setItem(ADMIN_AUTH_STORAGE_KEY, "active");
}

export function clearAdminSession() {
  window.localStorage.removeItem(ADMIN_AUTH_STORAGE_KEY);
}
