import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import HomePage from "@/app/page";
import type { Ticket } from "@/lib/domain/types";
import type { AppConfig } from "@/lib/seed";

const config: AppConfig = {
  issueTypes: [
    {
      id: "network",
      name: "Network",
      urgencyMinutes: 20,
      priorityWeight: 25,
      assignmentGroup: "Network Team",
      enabled: true
    }
  ],
  aiModels: [
    { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  userGroups: [
    {
      id: "business",
      name: "Business",
      description: "Business acceptance",
      canClaim: false,
      canProcess: false,
      canAccept: true,
      canAdmin: false,
      enabled: true
    },
    {
      id: "organizer",
      name: "Organizer",
      description: "Organizer acceptance",
      canClaim: false,
      canProcess: false,
      canAccept: true,
      canAdmin: false,
      enabled: true
    },
    {
      id: "builder",
      name: "Builder",
      description: "Builder processing",
      canClaim: true,
      canProcess: true,
      canAccept: false,
      canAdmin: false,
      enabled: true
    }
  ],
  assignmentRules: []
};

const ticket: Ticket = {
  id: "ticket-1",
  title: "A01 Network",
  boothNumber: "A01",
  companyName: "Star River",
  companyShortName: "Star",
  description: "Network is down",
  imageUrls: [],
  issueType: "Network",
  submitterId: "person-1",
  submitterName: "Alice",
  submitterPhone: "13800138000",
  feedbackUsers: [
    {
      userId: "person-1",
      userName: "Alice",
      phone: "13800138000",
      feedbackAt: "2026-05-21T08:00:00.000Z"
    }
  ],
  status: "pending" as Ticket["status"],
  handlerName: "Network Duty",
  assignmentGroup: "Network Team",
  urgeCount: 1,
  urgeLevel: 1,
  priorityScore: 55,
  aiDecisions: [],
  replies: [],
  timeline: [
    {
      id: "timeline-1",
      ticketId: "ticket-1",
      type: "submitted",
      body: "Network is down",
      createdAt: "2026-05-21T08:00:00.000Z",
      actorName: "Alice"
    }
  ],
  createdAt: "2026-05-21T08:00:00.000Z",
  updatedAt: "2026-05-21T08:00:00.000Z"
};

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "person-1",
    name: "Alice",
    phone: "13800138000",
    role: "member",
    groupId: "business",
    groupName: "Business",
    permissions: { canClaim: false, canProcess: false, canAccept: true },
    ...overrides
  };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("login and role access", () => {
  it("does not resolve browser session state while rendering the server shell", () => {
    const html = renderToString(<HomePage />);

    expect(html).toContain("loading");
    expect(html).not.toContain("auth-card");
  });

  it("loads configured user groups before member login", async () => {
    const loginConfig: AppConfig = {
      ...config,
      userGroups: [
        ...(config.userGroups ?? []),
        {
          id: "management",
          name: "Dynamic Management Group",
          description: "Configured in admin",
          canClaim: true,
          canProcess: true,
          canAccept: true,
          canAdmin: false,
          enabled: true
        }
      ]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      return new Response(JSON.stringify({ config: loginConfig }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    expect(await screen.findByRole("option", { name: "Dynamic Management Group" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session?type=mobile", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap?scope=login", { cache: "no-store" });
  });

  it("restores a valid mobile session before loading the board", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ user: sessionUser() }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("internal-board-current-user", JSON.stringify({ id: "member-old", name: "Old", role: "member" }));

    render(<HomePage />);

    expect(await screen.findByText("A01 Network")).not.toBeNull();
    expect(localStorage.getItem("internal-board-current-user")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session?type=mobile", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap?scope=mobile", { cache: "no-store" });
    expect(fetchMock).not.toHaveBeenCalledWith("/api/bootstrap?scope=login", { cache: "no-store" });
  });

  it("posts member login to the mobile auth route before using the board", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      if (url === "/api/bootstrap?scope=login") {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      if (url === "/api/auth/mobile/login") {
        return new Response(
          JSON.stringify({
            user: sessionUser({
              id: "person-builder",
              groupId: "builder",
              groupName: "Builder",
              permissions: { canClaim: true, canProcess: true, canAccept: false }
            })
          }),
          { status: 200 }
        );
      }
      if (url === "/api/bootstrap?scope=mobile") {
        return new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<HomePage />);

    expect(await screen.findByRole("option", { name: "Builder" })).not.toBeNull();
    await user.type(container.querySelector('input[name="name"]')!, "Alice");
    await user.type(container.querySelector('input[name="phone"]')!, "13800138000");
    await user.selectOptions(container.querySelector('select[name="groupId"]')!, "builder");
    await user.click(container.querySelector('button[type="submit"]')!);

    expect(await screen.findByText("A01 Network")).not.toBeNull();
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/auth/mobile/login");
    expect(loginCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      name: "Alice",
      phone: "13800138000",
      groupId: "builder"
    });
    expect(localStorage.getItem("internal-board-current-user")).toBeNull();
    const currentUser = container.querySelector(".hero-user");
    expect(currentUser?.textContent).toContain("Builder");
    expect(currentUser?.textContent).toContain("Alice");
    expect(currentUser?.textContent).toContain("13800138000");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("shows an error when member login cannot reach the auth route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      if (url === "/api/bootstrap?scope=login") {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      if (url === "/api/auth/mobile/login") {
        throw new Error("network failed");
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<HomePage />);

    expect(await screen.findByRole("option", { name: "Business" })).not.toBeNull();
    await user.type(container.querySelector('input[name="name"]')!, "Alice");
    await user.type(container.querySelector('input[name="phone"]')!, "13800138000");
    await user.click(container.querySelector('button[type="submit"]')!);

    expect(await screen.findByText("登录失败，请稍后重试")).not.toBeNull();
    expect(screen.queryByText("A01 Network")).toBeNull();
  });

  it("shows an error when the auth route returns a malformed success payload", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      if (url === "/api/bootstrap?scope=login") {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      if (url === "/api/auth/mobile/login") {
        return new Response("not-json", { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<HomePage />);

    expect(await screen.findByRole("option", { name: "Business" })).not.toBeNull();
    await user.type(container.querySelector('input[name="name"]')!, "Alice");
    await user.type(container.querySelector('input[name="phone"]')!, "13800138000");
    await user.click(container.querySelector('button[type="submit"]')!);

    expect(await screen.findByText("登录失败，请稍后重试")).not.toBeNull();
    expect(screen.queryByText("A01 Network")).toBeNull();
  });

  it("posts logout to the mobile auth route and returns to login", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ user: sessionUser() }), { status: 200 });
      }
      if (url === "/api/bootstrap?scope=mobile") {
        return new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 });
      }
      if (url === "/api/auth/mobile/logout") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/bootstrap?scope=login") {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<HomePage />);

    await screen.findByText("A01 Network");
    await user.click(container.querySelector(".hero-user button")!);

    expect(await screen.findByRole("option", { name: "Business" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/mobile/logout", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap?scope=login", { cache: "no-store" });
  });
});
