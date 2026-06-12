import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HomePage from "@/app/page";
import { AUTH_STORAGE_KEY } from "@/lib/client/auth";
import { defaultConfig } from "@/lib/seed";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const actor = {
  accountId: "account-1",
  personId: "person-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  permissions: ["ticket.claim", "ticket.process"],
  sessionType: "mobile"
};

describe("mobile page authentication", () => {
  it("restores the user from the server session and removes the legacy key", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ id: "legacy" }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ authenticated: true, user: actor }));
      }
      return new Response(JSON.stringify({ tickets: [], config: defaultConfig() }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session?type=mobile",
      { cache: "no-store" }
    ));
    await waitFor(() => expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull());
    expect(await screen.findByText(/张三/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /进入看板/ })).toBeNull();
  });

  it("posts the login form and uses the returned actor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }));
      }
      if (url.includes("/api/bootstrap?scope=login")) {
        return new Response(JSON.stringify({ config: defaultConfig() }));
      }
      if (url.includes("/api/auth/mobile/login")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ user: actor }));
      }
      return new Response(JSON.stringify({ tickets: [], config: defaultConfig() }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HomePage />);

    await user.type(await screen.findByLabelText("真实姓名"), "张三");
    await user.type(screen.getByLabelText("联系电话"), "13800138000");
    await user.selectOptions(screen.getByLabelText("用户分组"), "builder");
    await user.click(screen.getByRole("button", { name: /进入看板/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/mobile/login",
      expect.objectContaining({ method: "POST" })
    ));
    expect(await screen.findByText(/张三/)).not.toBeNull();
  });
});
