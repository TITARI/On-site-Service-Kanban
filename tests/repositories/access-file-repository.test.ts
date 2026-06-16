import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type {
  AuthenticatedActor,
  UserMutation
} from "@/lib/domain/access-control";
import type { Ticket, UserGroup } from "@/lib/domain/types";
import { USER_IMPORT_TEMPLATE_COLUMNS } from "@/lib/domain/user-import";
import { createFileAppRepository } from "@/lib/repositories/app-repository";
import { verifyPassword } from "@/lib/services/password-service";
import { sanitizeAuditValue } from "@/lib/services/access-state-service";
import {
  createSessionToken,
  sessionTokenHash
} from "@/lib/services/session-service";
import { defaultConfig } from "@/lib/seed";

type AccessTestState = AppState;

const [
  IMPORT_NAME_COLUMN,
  IMPORT_PHONE_COLUMN,
  IMPORT_GROUP_COLUMN,
  IMPORT_GROUP_LOCKED_COLUMN,
  IMPORT_ENABLED_COLUMN
] = USER_IMPORT_TEMPLATE_COLUMNS;

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "Builder",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "business",
    name: "Business",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: true,
    canAdmin: false,
    enabled: true
  },
  {
    id: "admin",
    name: "Administrators",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: false,
    canAdmin: true,
    enabled: true
  }
];

function accessState(): AccessTestState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    accounts: [],
    accountCredentials: [],
    roles: [],
    accountRoles: [],
    rolePermissions: [],
    accountSessions: [],
    auditLogs: [],
    authBootstrap: null,
    config: {
      ...defaultConfig(),
      userGroups: structuredClone(groups)
    }
  };
}

function memoryStore(initial = accessState()) {
  let current = structuredClone(initial);
  let updateQueue = Promise.resolve();
  const store = {
    readState: async () => structuredClone(current) as AppState,
    updateState: <T>(operation: (state: AppState) => Promise<T> | T) => {
      const queued = updateQueue.then(async () => {
        const draft = structuredClone(current);
        const result = await operation(draft);
        current = draft;
        return result;
      });
      updateQueue = queued.then(() => undefined, () => undefined);
      return queued;
    },
    mutate: (operation: (state: AccessTestState) => void) => {
      operation(current);
    },
    snapshot: () => structuredClone(current)
  };
  return store;
}

function testSessionHash(label: string) {
  return sessionTokenHash(`access-file-repository:${label}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function autoAcceptanceTicket(): Ticket {
  return {
    id: "ticket-auto-accept",
    title: "A01 network repair",
    boothNumber: "A01",
    companyName: "Example Company",
    companyShortName: "Example",
    description: "Network restored",
    imageUrls: [],
    issueType: "Network",
    submitterId: "person-submitter",
    submitterName: "Submitter",
    submitterPhone: "13800138009",
    reporterChatIdentityId: "chat-reporter",
    sourceConversationId: "conversation-site",
    feedbackUsers: [],
    status: "已解决",
    handlerId: "person-handler",
    handlerName: "Handler",
    assignmentGroup: "Builder",
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 25,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-06-05T07:00:00.000Z",
    updatedAt: "2026-06-05T08:00:00.000Z"
  };
}

function controllableAtomicStore(initial: AccessTestState) {
  let current = structuredClone(initial);
  let updateQueue = Promise.resolve();
  let controlsEnabled = false;
  let autoPausedInUpdate = false;
  let autoReleased = false;
  const autoPaused = deferred();
  const releaseAuto = deferred();

  const releasePausedAuto = () => {
    if (autoReleased) return;
    autoReleased = true;
    releaseAuto.resolve();
  };

  return {
    readState: async () => structuredClone(current) as AppState,
    updateState: <T>(operation: (state: AppState) => Promise<T> | T) => {
      if (controlsEnabled && autoPausedInUpdate) {
        releasePausedAuto();
      }
      const queued = updateQueue.then(async () => {
        const draft = structuredClone(current);
        const previousStatus = current.tickets[0]?.status;
        const result = await operation(draft);
        const closesTicket =
          previousStatus !== "已关闭" &&
          draft.tickets[0]?.status === "已关闭";
        if (controlsEnabled && closesTicket) {
          autoPausedInUpdate = true;
          autoPaused.resolve();
          await releaseAuto.promise;
        }
        current = draft as AccessTestState;
        return result;
      });
      updateQueue = queued.then(() => undefined, () => undefined);
      return queued;
    },
    beginInterleaving: () => {
      controlsEnabled = true;
    },
    waitForAutoPause: () => autoPaused.promise,
    snapshot: () => structuredClone(current)
  };
}

function expectAccountPersonIds(state: AccessTestState) {
  const people = state.people ?? [];
  const accounts = state.accounts ?? [];
  expect(new Set(people.map((person) => person.id)).size).toBe(people.length);
  expect(accounts).toHaveLength(people.length);
  for (const account of accounts) {
    expect(account.personId).toMatch(/^person-/);
    expect(account.id).toBe(`account-${account.personId}`);
  }
}

function adminActor(): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin"
  };
}

async function createMobile(
  repository: ReturnType<typeof createFileAppRepository>,
  groupId = "builder"
) {
  return repository.upsertMobileAccount({
    name: "Alice",
    phone: "138 0013-8000",
    groupId
  });
}

describe("file access repository", () => {
  it("normalizes mobile accounts, keeps stable ids, and respects admin group locks", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    const first = await createMobile(repository);
    const firstSnapshot = store.snapshot();
    const firstPersonId = first.actor.personId;
    const firstAccountId = first.actor.accountId;

    expect(first.actor).toMatchObject({
      phone: "13800138000",
      groupId: "builder",
      permissions: ["ticket.claim", "ticket.process"],
      sessionType: "mobile"
    });
    expect(firstPersonId).toMatch(/^person-/);
    expect(firstAccountId).toBe(`account-${firstPersonId}`);
    expect(firstSnapshot.accountRoles).toEqual([
      expect.objectContaining({
        accountId: firstAccountId,
        roleId: "role-builder"
      })
    ]);

    const moved = await repository.upsertMobileAccount({
      name: "Alice Updated",
      phone: "13800138000",
      groupId: "business"
    });
    expect(moved.actor).toMatchObject({
      personId: firstPersonId,
      accountId: firstAccountId,
      groupId: "business"
    });
    expect(store.snapshot().people).toHaveLength(1);
    expect(store.snapshot().accounts).toHaveLength(1);

    await repository.updateUser(
      firstPersonId,
      { groupId: "builder", groupLocked: true },
      adminActor()
    );
    const locked = await repository.upsertMobileAccount({
      name: "Alice Final",
      phone: "13800138000",
      groupId: "business"
    });

    expect(locked.actor).toMatchObject({
      personId: firstPersonId,
      accountId: firstAccountId,
      groupId: "builder"
    });
    expect(store.snapshot().accountRoles?.filter(
      (link) => link.accountId === firstAccountId
    )).toHaveLength(1);
  });

  it("does not reuse a mobile-created person id when the old phone is reused", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const original = await createMobile(repository);

    await repository.updateUser(
      original.actor.personId,
      { phone: "13900139000" },
      adminActor()
    );
    const replacement = await createMobile(repository);

    expect(original.actor.personId).toMatch(/^person-/);
    expect(replacement.actor.personId).toMatch(/^person-/);
    expect(replacement.actor.personId).not.toBe(original.actor.personId);
    await expect(
      repository.getUser(original.actor.personId)
    ).resolves.toMatchObject({ phone: "13900139000" });
    expectAccountPersonIds(store.snapshot());
  });

  it("does not reuse a createUser person id when the old phone is reused", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const actor = adminActor();
    const original = await repository.createUser({
      name: "Created User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor);

    await repository.updateUser(
      original.personId,
      { phone: "13900139000" },
      actor
    );
    const replacement = await repository.createUser({
      name: "Replacement User",
      phone: "13800138000",
      groupId: "business",
      groupLocked: false,
      enabled: true
    }, actor);

    expect(original.personId).toMatch(/^person-/);
    expect(replacement.personId).toMatch(/^person-/);
    expect(replacement.personId).not.toBe(original.personId);
    await expect(repository.getUser(original.personId)).resolves.toMatchObject({
      phone: "13900139000"
    });
    expectAccountPersonIds(store.snapshot());
  });

  it("does not reuse a prior person id when bootstrap reuses an old phone", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const original = await createMobile(repository);

    await repository.updateUser(
      original.actor.personId,
      { phone: "13900139000" },
      adminActor()
    );
    const bootstrap = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13800138000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    expect(original.actor.personId).toMatch(/^person-/);
    expect(bootstrap.personId).toMatch(/^person-/);
    expect(bootstrap.personId).not.toBe(original.actor.personId);
    await expect(
      repository.getUser(original.actor.personId)
    ).resolves.toMatchObject({ phone: "13900139000" });
    expectAccountPersonIds(store.snapshot());
  });

  it("derives actors only from persisted account-role-permission links", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const tokenHash = testSessionHash("persisted permissions");
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    store.mutate((state) => {
      const builder = state.config.userGroups?.find(
        (group) => group.id === "builder"
      );
      if (builder) {
        builder.canClaim = false;
        builder.canProcess = false;
        builder.canAdmin = true;
      }
    });

    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toMatchObject({
      actor: {
        permissions: ["ticket.claim", "ticket.process"]
      }
    });

    store.mutate((state) => {
      state.rolePermissions = [];
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toMatchObject({
      actor: { permissions: [] }
    });
  });

  it("rejects disabled users during JSON session resolution", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const tokenHash = testSessionHash("disabled session resolution");
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    store.mutate((state) => {
      const account = state.accounts?.find((item) => item.id === actor.accountId);
      const person = state.people?.find((item) => item.id === actor.personId);
      if (account) account.enabled = false;
      if (person) person.enabled = false;
    });

    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("strips nested secrets from JSON audit details", () => {
    const sanitized = sanitizeAuditValue({
      event: "sensitive",
      password: "clear-password",
      nested: {
        passwordHash: "hash-value",
        session: {
          value: "clear-session-token"
        },
        confirmationSecret: "clear-confirmation-secret"
      },
      tokenCount: 2
    });

    const auditText = JSON.stringify(sanitized);
    expect(auditText).not.toContain("clear-password");
    expect(auditText).not.toContain("hash-value");
    expect(auditText).not.toContain("clear-session-token");
    expect(auditText).not.toContain("clear-confirmation-secret");
    expect(auditText).not.toContain("password");
    expect(auditText).not.toContain("passwordHash");
    expect(auditText).not.toContain("session");
    expect(auditText).not.toContain("confirmationSecret");
    expect(sanitized).toEqual({
      event: "sensitive",
      nested: {},
      tokenCount: 2
    });
  });

  it("rejects non-canonical session token hashes without echoing them", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const canonicalHash = testSessionHash("canonical validation");
    const invalidHashes = [
      createSessionToken(),
      "g".repeat(64),
      canonicalHash.slice(0, -1),
      "A".repeat(64)
    ];

    for (const invalidHash of invalidHashes) {
      let error: unknown;
      try {
        await repository.createAccountSession(
          actor.accountId,
          "mobile",
          invalidHash,
          "2099-01-01T00:00:00.000Z"
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/session token hash/i);
      expect((error as Error).message).not.toContain(invalidHash);
    }

    expect(store.snapshot().accountSessions).toEqual([]);
  });

  it("stores hash-only sessions and validates type, expiry, revocation, and auth version", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const rawToken = "raw-session-token";
    const tokenHash = sessionTokenHash(rawToken);
    const session = await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    expect(session).toMatchObject({
      accountId: actor.accountId,
      sessionType: "mobile",
      tokenHash,
      authVersion: 1
    });
    expect(JSON.stringify(store.snapshot())).not.toContain(rawToken);
    expect(JSON.stringify(store.snapshot().auditLogs)).not.toContain(tokenHash);
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toMatchObject({
      session: { id: session.id },
      actor: { accountId: actor.accountId }
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "admin")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const stored = state.accountSessions?.find(
        (item) => item.id === session.id
      );
      if (stored) stored.expiresAt = "2000-01-01T00:00:00.000Z";
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const stored = state.accountSessions?.find(
        (item) => item.id === session.id
      );
      if (stored) stored.expiresAt = "2099-01-01T00:00:00.000Z";
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.authVersion += 1;
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("rejects a persisted session with malformed expiry text", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const tokenHash = testSessionHash("malformed expiry");
    const session = await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    store.mutate((state) => {
      const stored = state.accountSessions?.find(
        (item) => item.id === session.id
      );
      if (stored) stored.expiresAt = "not-an-expiry";
    });

    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("rejects sessions independently when the account or person is disabled", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const tokenHash = testSessionHash("enabled chain");
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeDefined();

    store.mutate((state) => {
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.enabled = false;
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.enabled = true;
    });
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeDefined();

    store.mutate((state) => {
      const person = state.people?.find(
        (item) => item.id === actor.personId
      );
      if (person) person.enabled = false;
    });
    expect(store.snapshot().accounts?.find(
      (item) => item.id === actor.accountId
    )?.enabled).toBe(true);
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("revokes one or all sessions and keeps record versions coherent", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const firstHash = testSessionHash("first revoke");
    const secondHash = testSessionHash("second revoke");
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      firstHash,
      "2099-01-01T00:00:00.000Z"
    );
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      secondHash,
      "2099-01-01T00:00:00.000Z"
    );

    await repository.revokeAccountSession(firstHash);
    await expect(
      repository.resolveAccountSession(firstHash, "mobile")
    ).resolves.toBeUndefined();
    await expect(
      repository.resolveAccountSession(secondHash, "mobile")
    ).resolves.toBeDefined();

    const before = store.snapshot().accounts?.[0]?.authVersion ?? 0;
    await repository.revokeAccountSessions(actor.accountId);
    const snapshot = store.snapshot();

    expect(snapshot.accounts?.[0]?.authVersion).toBe(before + 1);
    expect(snapshot.accountSessions?.filter(
      (item) => item.accountId === actor.accountId
    ).every((item) => Boolean(item.revokedAt))).toBe(true);
    expect(snapshot.accountSessions?.filter(
      (item) => item.accountId === actor.accountId
    ).every((item) => item.authVersion === before)).toBe(true);
    await expect(
      repository.resolveAccountSession(secondHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("attributes failed admin login audits to the unauthenticated system actor", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    const credentialHash = store.snapshot().accountCredentials?.find(
      (credential) => credential.accountId === admin.accountId
    )?.passwordHash;
    store.mutate((state) => {
      state.auditLogs = [];
    });

    await repository.recordAdminLoginFailure(
      admin.accountId,
      "2099-01-01T00:00:00.000Z"
    );

    const [entry] = store.snapshot().auditLogs ?? [];
    expect(entry).toMatchObject({
      actorName: "system",
      action: "admin.login.failure",
      targetType: "account",
      targetId: admin.accountId,
      detail: {
        failedAttempts: 1,
        lockedUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    expect(entry).not.toHaveProperty("actorId");
    expect(credentialHash).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(credentialHash as string);
    expect(JSON.stringify(entry)).not.toContain("StrongPass123!");
  });

  it("handles admin login records, lock counters, and successful login state", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "137 0013-7000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(
      repository.adminLoginRecord("13700137000")
    ).resolves.toMatchObject({
      actor: { accountId: admin.accountId },
      credential: { failedAttempts: 0 }
    });

    store.mutate((state) => {
      state.accountCredentials = [];
    });
    await expect(
      repository.adminLoginRecord("13700137000")
    ).resolves.toBeUndefined();

    await repository.setUserPassword(
      admin.personId,
      "scrypt$stored-hash",
      admin
    );
    const lockedUntil = "2099-01-01T00:00:00.000Z";
    await repository.recordAdminLoginFailure(admin.accountId, lockedUntil);
    await repository.recordAdminLoginFailure(admin.accountId);
    await expect(
      repository.adminLoginRecord("137 0013 7000")
    ).resolves.toMatchObject({
      credential: {
        failedAttempts: 2,
        lockedUntil
      }
    });

    await repository.recordAdminLoginSuccess(admin.accountId);
    const record = await repository.adminLoginRecord("13700137000");
    expect(record?.credential).toMatchObject({
      failedAttempts: 0,
      lockedUntil: undefined
    });
    expect(record?.actor).toMatchObject({ accountId: admin.accountId });
    expect(store.snapshot().accounts?.[0]?.lastLoginAt).toBeTruthy();
  });

  it("bootstraps once with existing or new admin groups and never persists plaintext secrets", async () => {
    const existingStore = memoryStore();
    const existingRepository = createFileAppRepository(existingStore);

    await expect(existingRepository.bootstrapStatus()).resolves.toEqual({
      required: true
    });
    await expect(existingRepository.bootstrapAdmin({
      legacyPassword: "",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toThrow(/legacy/i);

    const admin = await existingRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    expect(admin.accountId).toBe(`account-${admin.personId}`);

    await expect(existingRepository.bootstrapStatus()).resolves.toEqual({
      required: false
    });
    await expect(existingRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Second Admin",
      phone: "13600136000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toThrow(/bootstrap|initial/i);

    const stored = existingStore.snapshot();
    const credential = stored.accountCredentials?.find(
      (item) => item.accountId === admin.accountId
    );
    expect(credential?.passwordHash).not.toBe("StrongPass123!");
    await expect(
      verifyPassword("StrongPass123!", credential?.passwordHash ?? "")
    ).resolves.toBe(true);
    expect(JSON.stringify(stored.auditLogs)).not.toContain("legacy-secret");
    expect(JSON.stringify(stored.auditLogs)).not.toContain("StrongPass123!");

    const createStore = memoryStore();
    const createRepository = createFileAppRepository(createStore);
    const created = await createRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Created Admin",
      phone: "13600136000",
      password: "StrongPass123!",
      group: { mode: "create", name: "New Admin Group" }
    });
    expect(created.accountId).toBe(`account-${created.personId}`);
    expect(created.permissions).toContain("admin.access");
    expect(createStore.snapshot().config.userGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "New Admin Group",
          canAdmin: true,
          enabled: true
        })
      ])
    );
  });

  it("creates bootstrap admin entities and the first admin session in one atomic file update", async () => {
    const initial = accessState();
    let current = structuredClone(initial);
    let updates = 0;
    const expectedHash = testSessionHash("atomic bootstrap admin");
    const store = {
      readState: async () => structuredClone(current) as AppState,
      updateState: async <T>(operation: (state: AppState) => Promise<T> | T) => {
        updates += 1;
        const draft = structuredClone(current);
        const result = await operation(draft);
        if (updates === 1) {
          const session = draft.accountSessions?.find(
            (item) => item.tokenHash === expectedHash
          );
          if (!session) {
            throw new Error("session missing from bootstrap transaction");
          }
          throw new Error("rollback bootstrap transaction after session insert");
        }
        current = draft;
        return result;
      }
    };
    const repository = createFileAppRepository(store);

    await expect((repository as unknown as {
      bootstrapAdminWithSession: (
        input: Parameters<typeof repository.bootstrapAdmin>[0],
        tokenHash: string,
        expiresAt: string
      ) => ReturnType<typeof repository.bootstrapAdmin>;
    }).bootstrapAdminWithSession(
      {
        legacyPassword: "legacy-secret",
        name: "Root Admin",
        phone: "13700137000",
        password: "StrongPass123!",
        group: { mode: "existing", groupId: "admin" }
      },
      expectedHash,
      "2099-01-01T00:00:00.000Z"
    )).rejects.toThrow(/rollback bootstrap transaction/);

    expect(updates).toBe(1);
    expect(current).toEqual(initial);
  });

  it.each([
    ["wx-external-only"],
    ["PUBLIC ALIAS ALPHA"],
    ["corp-external-only"],
    ["ENTERPRISE ALIAS BETA"],
    ["WECHAT"],
    ["WECOM"]
  ])("searches linked chat identity values without duplicating users for %s", async (search) => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Identity Holder",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      state.chatIdentities = [
        {
          id: "chat-wechat",
          platform: "wechat",
          externalUserId: "WX-EXTERNAL-ONLY",
          displayName: "Public Alias Alpha",
          personId: user.personId,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "chat-wecom",
          platform: "wecom",
          externalUserId: "CORP-EXTERNAL-ONLY",
          displayName: "Enterprise Alias Beta",
          personId: user.personId,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "chat-unlinked",
          platform: "wechat",
          externalUserId: "UNLINKED-ONLY",
          displayName: "Unlinked Alias",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z"
        }
      ];
    });

    await expect(repository.listUsers({
      search,
      page: 1,
      pageSize: 20
    })).resolves.toEqual({
      total: 1,
      users: [expect.objectContaining({ personId: user.personId })]
    });
    await expect(repository.listUsers({
      search: "unlinked-only",
      page: 1,
      pageSize: 20
    })).resolves.toEqual({
      total: 0,
      users: []
    });
  });

  it("allows unrelated updates and disabling a user in a disabled group", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Disabled Group User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      const group = state.config.userGroups?.find(
        (item) => item.id === "builder"
      );
      if (group) group.enabled = false;
    });

    await expect(repository.updateUser(user.personId, {
      name: "Renamed While Disabled",
      phone: "13900139000",
      groupLocked: true,
      enabled: false
    }, adminActor())).resolves.toMatchObject({
      name: "Renamed While Disabled",
      phone: "13900139000",
      groupId: "builder",
      groupName: "Builder",
      groupLocked: true,
      enabled: false
    });
  });

  it("rejects enabling a user whose effective group is disabled", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Disabled User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: false
    }, adminActor());
    store.mutate((state) => {
      const group = state.config.userGroups?.find(
        (item) => item.id === "builder"
      );
      if (group) group.enabled = false;
    });

    await expect(
      repository.setUserEnabled(user.personId, true, adminActor())
    ).rejects.toThrow(/group.*disabled|missing/i);
    expect(store.snapshot().people?.find(
      (person) => person.id === user.personId
    )?.enabled).toBe(false);
    expect(store.snapshot().accounts?.find(
      (account) => account.id === user.accountId
    )?.enabled).toBe(false);
  });

  it("allows moving and enabling a user in one mutation to an enabled group", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Moving User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: false
    }, adminActor());
    store.mutate((state) => {
      const group = state.config.userGroups?.find(
        (item) => item.id === "builder"
      );
      if (group) group.enabled = false;
    });

    await expect(repository.updateUser(user.personId, {
      groupId: "business",
      enabled: true
    }, adminActor())).resolves.toMatchObject({
      groupId: "business",
      groupName: "Business",
      enabled: true
    });
    expect(store.snapshot().accountRoles?.filter(
      (assignment) => assignment.accountId === user.accountId
    )).toEqual([
      expect.objectContaining({ roleId: "role-business" })
    ]);
  });

  it("revokes sessions when only group lock changes", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Lock User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    const tokenHash = testSessionHash("group lock update");
    await repository.createAccountSession(
      user.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );
    const before = store.snapshot().accounts?.find(
      (item) => item.id === user.accountId
    )?.authVersion ?? 0;

    await repository.updateUser(user.personId, {
      groupLocked: true
    }, adminActor());

    expect(store.snapshot().accounts?.find(
      (item) => item.id === user.accountId
    )?.authVersion).toBe(before + 1);
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
    expect(store.snapshot().auditLogs?.at(-1)?.detail).toMatchObject({
      authInvalidated: true
    });
  });

  it("supports user CRUD, filters, pagination, auth invalidation, and secret-safe audits", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const actor = adminActor();
    const inputs: UserMutation[] = [
      {
        name: "Alice Builder",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: false,
        enabled: true
      },
      {
        name: "Bob Business",
        phone: "13900139000",
        groupId: "business",
        groupLocked: false,
        enabled: true
      },
      {
        name: "Carol Admin",
        phone: "13700137000",
        groupId: "admin",
        groupLocked: true,
        enabled: true
      }
    ];
    const created = [];
    for (const input of inputs) {
      created.push(await repository.createUser(input, actor));
    }
    for (const user of created) {
      expect(user.accountId).toBe(`account-${user.personId}`);
    }
    const nameSessionHash = testSessionHash("name update");
    store.mutate((state) => {
      state.chatIdentities?.push({
        id: "chat-alice",
        platform: "wechat",
        externalUserId: "wx-alice",
        displayName: "Alice",
        personId: created[0].personId,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z"
      });
    });

    await expect(repository.getUser(created[0].accountId)).resolves.toMatchObject({
      personId: created[0].personId,
      permissions: ["ticket.claim", "ticket.process"],
      identities: {
        wechat: { externalUserId: "wx-alice" }
      }
    });
    await expect(repository.listUsers({
      search: "alice",
      groupId: "builder",
      enabled: true,
      admin: false,
      binding: "bound",
      page: 1,
      pageSize: 10
    })).resolves.toMatchObject({
      total: 1,
      users: [expect.objectContaining({ personId: created[0].personId })]
    });
    await expect(repository.listUsers({
      page: 2,
      pageSize: 2
    })).resolves.toMatchObject({
      total: 3,
      users: [expect.objectContaining({ name: "Carol Admin" })]
    });

    await repository.createAccountSession(
      created[0].accountId,
      "mobile",
      nameSessionHash,
      "2099-01-01T00:00:00.000Z"
    );
    const initialVersion = store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion ?? 0;
    await repository.updateUser(created[0].personId, {
      name: "Alice Renamed"
    }, actor);
    expect(store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion).toBe(initialVersion);
    await expect(
      repository.resolveAccountSession(nameSessionHash, "mobile")
    ).resolves.toBeDefined();

    for (const mutation of [
      { phone: "13600136000" },
      { groupId: "business" },
      { enabled: false }
    ]) {
      const before = store.snapshot().accounts?.find(
        (item) => item.id === created[0].accountId
      )?.authVersion ?? 0;
      await repository.updateUser(created[0].personId, mutation, actor);
      expect(store.snapshot().accounts?.find(
        (item) => item.id === created[0].accountId
      )?.authVersion).toBe(before + 1);
    }

    await repository.setUserEnabled(created[0].personId, true, actor);
    const beforePassword = store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion ?? 0;
    await repository.setUserPassword(
      created[0].personId,
      "scrypt$private-password-hash",
      actor
    );
    expect(store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion).toBe(beforePassword + 1);

    const auditText = JSON.stringify(store.snapshot().auditLogs);
    expect(auditText).toContain(actor.accountId);
    expect(auditText).toContain(created[0].personId);
    expect(auditText).not.toContain("scrypt$private-password-hash");
    expect(auditText).not.toContain(nameSessionHash);
    expect(auditText).not.toContain("tokenHash");
    expect(auditText).not.toContain("passwordHash");

    await repository.deleteUser(created[1].personId, actor);
    await expect(
      repository.getUser(created[1].personId)
    ).resolves.toBeUndefined();
    expect(store.snapshot().accounts?.some(
      (item) => item.id === created[1].accountId
    )).toBe(false);
  });

  it("blocks deletion when the person has business history", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Reporter",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      state.tickets = [
        {
          ...autoAcceptanceTicket(),
          id: "ticket-reported",
          reporterPersonId: user.personId
        }
      ];
    });

    await expect(
      repository.deleteUser(user.personId, adminActor())
    ).rejects.toThrow(/business history|cannot be deleted/i);
    await expect(repository.getUser(user.personId)).resolves.toBeDefined();
  });

  it("allows deletion when only target maintenance audits exist", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Maintenance Only",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      state.auditLogs?.push({
        id: "audit-target-only",
        actorId: "account-admin",
        actorName: "Root Admin",
        action: "user.update",
        targetType: "user",
        targetId: user.personId,
        detail: { accountId: user.accountId },
        createdAt: "2026-06-15T00:00:00.000Z"
      });
    });

    await repository.deleteUser(user.personId, adminActor());

    await expect(repository.getUser(user.personId)).resolves.toBeUndefined();
  });

  it("protects the final usable administrator from disable and deletion", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(
      repository.setUserEnabled(admin.personId, false, admin)
    ).rejects.toThrow("At least one usable admin account is required");
    await expect(
      repository.deleteUser(admin.personId, admin)
    ).rejects.toThrow("At least one usable admin account is required");

    await expect(repository.getUser(admin.personId)).resolves.toMatchObject({
      enabled: true,
      permissions: ["admin.access"]
    });
  });

  it("synchronizes exact roles and permissions while maintaining one role per account", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    store.mutate((state) => {
      state.accountRoles?.push({
        accountId: actor.accountId,
        roleId: "role-business",
        createdAt: "2026-01-01T00:00:00.000Z"
      });
      state.rolePermissions?.push({
        roleId: "role-builder",
        permissionCode: "admin.access",
        createdAt: "2026-01-01T00:00:00.000Z"
      });
    });

    const nextGroups = groups.map((group) => (
      group.id === "builder"
        ? {
            ...group,
            canClaim: false,
            canProcess: true,
            canAdmin: false
          }
        : group
    ));
    await repository.syncAccessRoles(nextGroups, adminActor());

    const snapshot = store.snapshot();
    expect(snapshot.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "role-builder",
        sourceGroupId: "builder"
      })
    ]));
    expect(snapshot.rolePermissions?.filter(
      (item) => item.roleId === "role-builder"
    )).toEqual([
      expect.objectContaining({ permissionCode: "ticket.process" })
    ]);
    expect(snapshot.accountRoles?.filter(
      (item) => item.accountId === actor.accountId
    )).toEqual([
      expect.objectContaining({ roleId: "role-builder" })
    ]);
  });

  it("invalidates authorization when saveConfig changes access groups", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const tokenHash = testSessionHash("config invalidation");
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );
    const before = store.snapshot().accounts?.[0]?.authVersion ?? 0;

    await repository.saveConfig({
      ...store.snapshot().config,
      userGroups: groups.map((group) => (
        group.id === "builder"
          ? { ...group, enabled: false }
          : group
      ))
    });

    expect(store.snapshot().accounts?.[0]?.authVersion).toBe(before + 1);
    await expect(
      repository.resolveAccountSession(tokenHash, "mobile")
    ).resolves.toBeUndefined();
  });

  it("rejects config saves that would remove the last usable admin", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(repository.saveConfig({
      ...store.snapshot().config,
      userGroups: groups.map((group) => (
        group.id === "admin"
          ? { ...group, canAdmin: false }
          : group
      ))
    })).rejects.toThrow("At least one usable admin account is required");

    expect(store.snapshot().config.userGroups?.find((group) => group.id === "admin")?.canAdmin).toBe(true);
  });

  it("protects the final usable admin from user disable and deletion", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(
      repository.setUserEnabled(admin.personId, false, admin)
    ).rejects.toThrow("At least one usable admin account is required");
    await expect(
      repository.deleteUser(admin.personId, admin)
    ).rejects.toThrow("At least one usable admin account is required");

    const snapshot = store.snapshot();
    expect(snapshot.people?.find(
      (person) => person.id === admin.personId
    )?.enabled).toBe(true);
    expect(snapshot.accounts?.find(
      (account) => account.id === admin.accountId
    )?.enabled).toBe(true);
  });

  it("reports user deletion history from business records but not target-only maintenance audits", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "History User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      state.auditLogs?.push({
        id: "audit-target",
        actorName: "Admin",
        action: "user.update",
        targetType: "user",
        targetId: user.personId,
        detail: {},
        createdAt: "2026-06-15T00:00:00.000Z"
      });
    });

    await expect(repository.userDeletionHistory(user.personId)).resolves.toEqual({
      hasHistory: false,
      reasons: []
    });

    store.mutate((state) => {
      state.tickets.push({
        id: "ticket-history",
        title: "History",
        boothNumber: "A01",
        companyName: "Example Company",
        companyShortName: "Example",
        description: "History",
        imageUrls: [],
        issueType: "Network",
        submitterId: user.personId,
        submitterName: "History User",
        submitterPhone: "13800138000",
        reporterPersonId: user.personId,
        feedbackUsers: [],
        status: autoAcceptanceTicket().status,
        urgeCount: 0,
        urgeLevel: 0,
        priorityScore: 0,
        aiDecisions: [],
        replies: [],
        timeline: [],
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z"
      });
    });

    await expect(repository.userDeletionHistory(user.personId)).resolves.toEqual({
      hasHistory: true,
      reasons: expect.arrayContaining(["tickets.reporter_person_id"])
    });
  });

  it("blocks deletion when the person is linked to a conversation", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const user = await repository.createUser({
      name: "Conversation Member",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, adminActor());
    store.mutate((state) => {
      state.conversations = [
        {
          id: "conversation-site",
          platform: "wechat",
          type: "group",
          externalConversationId: "site-group",
          title: "Site Group",
          linkedPersonIds: [user.personId],
          defaultNotify: true,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ];
    });

    await expect(repository.userDeletionHistory(user.personId)).resolves.toEqual({
      hasHistory: true,
      reasons: expect.arrayContaining(["conversation_people.person_id"])
    });
    await expect(
      repository.deleteUser(user.personId, adminActor())
    ).rejects.toThrow(/business history|cannot be deleted/i);
  });

  it("keeps auto acceptance and an interleaved access mutation atomic", async () => {
    const initial = accessState();
    initial.tickets = [autoAcceptanceTicket()];
    initial.config.autoAcceptance = {
      enabled: true,
      timeoutMinutes: 1
    };
    const store = controllableAtomicStore(initial);
    const autoRepository = createFileAppRepository(store);
    const accessRepository = createFileAppRepository(store);
    const { actor } = await createMobile(accessRepository);
    store.beginInterleaving();

    const autoAcceptance = autoRepository.runAutoAcceptance(
      new Date("2026-06-05T08:01:00.000Z")
    );
    await store.waitForAutoPause();
    const passwordUpdate = accessRepository.setUserPassword(
      actor.personId,
      "scrypt$interleaved-hash",
      actor
    );
    await Promise.all([autoAcceptance, passwordUpdate]);

    const snapshot = store.snapshot();
    expect(snapshot.tickets[0]?.status).toBe("已关闭");
    expect(snapshot.accountCredentials?.find(
      (credential) => credential.accountId === actor.accountId
    )?.passwordHash).toBe("scrypt$interleaved-hash");
  });

  it("serializes mutations through one atomic store across repository instances", async () => {
    const store = memoryStore();
    const firstRepository = createFileAppRepository(store);
    const secondRepository = createFileAppRepository(store);
    const { actor } = await createMobile(firstRepository);
    await firstRepository.setUserPassword(
      actor.personId,
      "scrypt$stored-hash",
      actor
    );

    await Promise.all([
      firstRepository.recordAdminLoginFailure(actor.accountId),
      secondRepository.recordAdminLoginFailure(actor.accountId)
    ]);

    expect(store.snapshot().accountCredentials?.find(
      (item) => item.accountId === actor.accountId
    )?.failedAttempts).toBe(2);
  });

  it("rejects empty or invalid normalized phones deterministically", async () => {
    const repository = createFileAppRepository(memoryStore());

    await expect(repository.upsertMobileAccount({
      name: "Empty",
      phone: " -- ",
      groupId: "builder"
    })).rejects.toThrow(/phone|mobile/i);
    await expect(repository.upsertMobileAccount({
      name: "Invalid",
      phone: "12345",
      groupId: "builder"
    })).rejects.toThrow(/phone|mobile/i);
  });

  it("persists user import preview jobs and validates decisions without mutating users", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    const preview = await repository.saveUserImportPreview({
      sourceName: "users.xlsx",
      sourceHash: "b".repeat(64),
      rows: [
        {
          姓名: "张三",
          手机号: "138 0013 8000",
          分组: "Builder",
          分组锁定: "是",
          启用状态: "启用",
          微信账号标识: "wxid-zhang",
          企微账号标识: "wecom-zhang",
          无关列: "discard me"
        }
      ]
    }, adminActor());

    expect(preview).toMatchObject({
      jobId: expect.stringMatching(/^import-/),
      previewVersion: expect.any(String),
      summary: { total: 1, selectable: 1, blocked: 0 }
    });

    await repository.saveUserImportDecisions(preview.jobId, [
      {
        rowId: preview.rows[0].id,
        decision: {
          action: "add",
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }
      }
    ], adminActor());

    const saved = await repository.getUserImportJobRows(
      preview.jobId,
      adminActor()
    );
    expect(saved.rows[0]).toMatchObject({
      category: "add",
      value: {
        name: "张三",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: true,
        enabled: true,
        wechatExternalUserId: "wxid-zhang",
        wecomExternalUserId: "wecom-zhang"
      },
      decision: {
        action: "add",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      }
    });
    expect(saved.rows[0].value).not.toHaveProperty("无关列");
    expect(store.snapshot().people).toHaveLength(0);
    expect(store.snapshot().accounts).toHaveLength(0);
  });

  it("commits an unchanged overwrite import and records a commit audit atomically", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const actor = adminActor();
    const existing = await repository.createUser({
      name: "Existing User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor);

    const preview = await repository.saveUserImportPreview({
      sourceName: "users.xlsx",
      sourceHash: "d".repeat(64),
      rows: [{
        [IMPORT_NAME_COLUMN]: "Updated User",
        [IMPORT_PHONE_COLUMN]: "13800138000",
        [IMPORT_GROUP_COLUMN]: "Business",
        [IMPORT_GROUP_LOCKED_COLUMN]: "true",
        [IMPORT_ENABLED_COLUMN]: "true"
      }]
    }, actor);
    await repository.saveUserImportDecisions(preview.jobId, [{
      rowId: preview.rows[0].id,
      decision: {
        action: "overwrite",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      }
    }], actor);

    await expect(repository.applyUserImport({
      ...await repository.loadImportJob(preview.jobId, actor),
      rows: (await repository.loadImportJob(preview.jobId, actor)).rows.filter(
        (row) => row.decision?.action !== "skip"
      )
    }, actor)).resolves.toEqual({ committed: 1 });

    await expect(repository.getUser(existing.personId)).resolves.toMatchObject({
      name: "Updated User",
      phone: "13800138000",
      groupId: "business",
      groupLocked: true
    });
    expect(store.snapshot().auditLogs?.at(-1)).toMatchObject({
      action: "user_import.commit",
      targetType: "import_job",
      targetId: preview.jobId,
      detail: { committed: 1, sourceName: "users.xlsx" }
    });
  });

  it("reports stale import rows as failed instead of user-skipped", async () => {
    const repository = createFileAppRepository(memoryStore());
    const actor = adminActor();
    const preview = await repository.saveUserImportPreview({
      sourceName: "users.xlsx",
      sourceHash: "e".repeat(64),
      rows: [{
        [IMPORT_NAME_COLUMN]: "Stale User",
        [IMPORT_PHONE_COLUMN]: "13800138001",
        [IMPORT_GROUP_COLUMN]: "Builder",
        [IMPORT_GROUP_LOCKED_COLUMN]: "false",
        [IMPORT_ENABLED_COLUMN]: "true"
      }]
    }, actor);
    await repository.saveUserImportDecisions(preview.jobId, [{
      rowId: preview.rows[0].id,
      decision: {
        action: "add",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      }
    }], actor);

    await repository.markUserImportRowsStale(
      preview.jobId,
      [preview.rows[0].id],
      actor
    );

    await expect(repository.userImportReport(preview.jobId, actor)).resolves.toEqual([
      expect.objectContaining({
        rowNumber: 1,
        name: "Stale User",
        action: "blocked",
        status: "failed",
        message: expect.stringContaining("stale-preview")
      })
    ]);
  });
});
