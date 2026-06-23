import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { Ticket } from "@/lib/domain/types";
import { toTicketSummary } from "@/lib/domain/ticket-summary";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const MOBILE_TOKEN = Buffer.alloc(32, 7).toString("base64url");

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  listTicketSummaries: vi.fn(),
  getTicket: vi.fn(),
  saveTicket: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    listTicketSummaries: store.listTicketSummaries,
    getTicket: store.getTicket,
    saveTicket: store.saveTicket,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const ticketsRoute = await import("@/app/api/tickets/route");
const ticketRoute = await import("@/app/api/tickets/[ticketId]/route");
const repliesRoute = await import("@/app/api/tickets/[ticketId]/replies/route");

type TestActor = {
  personId: string;
  groupName: string;
  permissions: string[];
};

const tickets: Ticket[] = [];

function ticket(input: Partial<Ticket> & Pick<Ticket, "id" | "submitterId">): Ticket {
  return {
    id: input.id,
    title: input.title ?? `${input.id} title`,
    boothNumber: "A01",
    companyName: "上海星河科技有限公司",
    companyShortName: "星河科技",
    description: "网络断开",
    imageUrls: [],
    issueType: "网络",
    submitterId: input.submitterId,
    submitterName: input.submitterName ?? "提交人",
    submitterPhone: input.submitterPhone ?? "13900139000",
    feedbackUsers: [],
    status: "待受理",
    acceptedAt: undefined,
    handlerId: input.handlerId,
    handlerName: input.handlerName,
    handlerPhone: input.handlerPhone,
    assignmentGroup: input.assignmentGroup,
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 0,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function visibleTo(ticket: Pick<Ticket, "submitterId" | "handlerId" | "assignmentGroup">, actor?: TestActor) {
  if (!actor) return true;
  return actor.permissions.includes("admin.access")
    || ticket.submitterId === actor.personId
    || ticket.handlerId === actor.personId
    || ticket.assignmentGroup === actor.groupName;
}

function actor(input: Partial<TestActor> = {}) {
  const personId = input.personId ?? "person-a";
  return {
    accountId: `account-${personId}`,
    personId,
    name: `${personId} name`,
    phone: "13900139000",
    groupId: input.groupName ?? "业务组",
    groupName: input.groupName ?? "业务组",
    permissions: input.permissions ?? [],
    sessionType: "mobile"
  };
}

function session(testActor = actor()) {
  return {
    actor: testActor,
    session: {
      id: "session-mobile",
      accountId: testActor.accountId,
      sessionType: "mobile",
      tokenHash: "hash-mobile",
      authVersion: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  };
}

function mobileRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}`,
      ...init.headers
    }
  });
}

beforeEach(() => {
  tickets.splice(0, tickets.length,
    ticket({ id: "ticket-a", submitterId: "person-a" }),
    ticket({ id: "ticket-b", submitterId: "person-b", assignmentGroup: "电工组" }),
    ticket({ id: "ticket-group", submitterId: "person-b", assignmentGroup: "搭建组" })
  );
  store.runAutoAcceptance.mockReset().mockResolvedValue(undefined);
  store.listTicketSummaries.mockReset().mockImplementation(async (actorArg?: TestActor) => (
    tickets.map(toTicketSummary).filter((item) => visibleTo(item, actorArg))
  ));
  store.getTicket.mockReset().mockImplementation(async (ticketId: string, actorArg?: TestActor) => {
    const found = tickets.find((item) => item.id === ticketId);
    return found && visibleTo(found, actorArg) ? found : undefined;
  });
  store.saveTicket.mockReset().mockImplementation(async (saved) => saved);
  store.resolveAccountSession.mockReset().mockResolvedValue(session());
});

describe("ticket authorization", () => {
  it("移动用户 A 看不到移动用户 B 的工单列表", async () => {
    const response = await ticketsRoute.GET(mobileRequest("http://localhost/api/tickets"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tickets.map((item: { id: string }) => item.id)).toEqual(["ticket-a"]);
  });

  it("移动用户 A GET /api/tickets/{B 的工单} 返回 404", async () => {
    const response = await ticketRoute.GET(mobileRequest("http://localhost/api/tickets/ticket-b"), {
      params: Promise.resolve({ ticketId: "ticket-b" })
    });

    expect(response.status).toBe(404);
  });

  it("移动用户 A POST /api/tickets/{B 的工单}/replies 返回 404", async () => {
    const response = await repliesRoute.POST(mobileRequest("http://localhost/api/tickets/ticket-b/replies", {
      method: "POST",
      body: JSON.stringify({ body: "补充信息", imageUrls: [] })
    }), { params: Promise.resolve({ ticketId: "ticket-b" }) });

    expect(response.status).toBe(404);
    expect(store.saveTicket).not.toHaveBeenCalled();
  });

  it("同组处理人可以看到工单", async () => {
    const handler = actor({ personId: "person-handler", groupName: "搭建组", permissions: ["ticket.process"] });
    store.resolveAccountSession.mockResolvedValue(session(handler));

    const response = await ticketRoute.GET(mobileRequest("http://localhost/api/tickets/ticket-group"), {
      params: Promise.resolve({ ticketId: "ticket-group" })
    });

    expect(response.status).toBe(200);
    expect(store.getTicket).toHaveBeenCalledWith("ticket-group", {
      personId: "person-handler",
      groupName: "搭建组",
      permissions: ["ticket.process"]
    });
  });

  it("管理员可以看到所有工单", async () => {
    const admin = actor({ personId: "person-admin", groupName: "管理组", permissions: ["admin.access"] });
    store.resolveAccountSession.mockResolvedValue(session(admin));

    const response = await ticketsRoute.GET(mobileRequest("http://localhost/api/tickets"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tickets.map((item: { id: string }) => item.id)).toEqual(["ticket-a", "ticket-b", "ticket-group"]);
    expect(store.listTicketSummaries).toHaveBeenCalledWith({
      personId: "person-admin",
      groupName: "管理组",
      permissions: ["admin.access"]
    });
  });
});
