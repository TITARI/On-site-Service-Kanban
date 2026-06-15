import { z } from "zod";
import type {
  AuthenticatedActor,
  UserMutation
} from "@/lib/domain/access-control";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { hashPassword } from "@/lib/services/password-service";

export const userMutationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  groupId: z.string().min(1).max(64),
  groupLocked: z.boolean(),
  enabled: z.boolean()
});

export class UserAdminNotFoundError extends Error {
  constructor(message = "User was not found") {
    super(message);
    this.name = "UserAdminNotFoundError";
  }
}

export class UserAdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAdminConflictError";
  }
}

export class UserAdminValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAdminValidationError";
  }
}

function duplicatePhoneError(error: unknown) {
  return error instanceof Error &&
    /phone.*already assigned|duplicate/i.test(error.message);
}

function notFoundError(error: unknown) {
  return error instanceof Error && /not found/i.test(error.message);
}

function conflictError(error: unknown) {
  return error instanceof Error &&
    /usable admin|business history|cannot be deleted|referenced/i.test(error.message);
}

function mapRepositoryError(error: unknown): never {
  if (duplicatePhoneError(error) || conflictError(error)) {
    throw new UserAdminConflictError((error as Error).message);
  }
  if (notFoundError(error)) {
    throw new UserAdminNotFoundError();
  }
  throw error;
}

function parseMutation(input: unknown): UserMutation {
  try {
    return userMutationSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new UserAdminValidationError(
        error.issues.map((issue) => issue.message).join("; ")
      );
    }
    throw error;
  }
}

function parsePassword(input: unknown) {
  const value = typeof input === "object" && input !== null
    ? (input as { password?: unknown }).password
    : input;
  return z.string().min(1).parse(value);
}

export function createUserAdminService(repository: AppRepository) {
  async function existingUser(userId: string) {
    const user = await repository.getUser(userId);
    if (!user) throw new UserAdminNotFoundError();
    return user;
  }

  async function assertNotLastAdmin(
    userId: string,
    actionWouldRemoveAccess: boolean
  ) {
    if (!actionWouldRemoveAccess) return;
    if (typeof repository.countUsableAdmins !== "function") return;
    const user = await existingUser(userId);
    if (
      user.enabled &&
      user.hasPassword &&
      user.permissions.includes("admin.access") &&
      await repository.countUsableAdmins() <= 1
    ) {
      throw new UserAdminConflictError(
        "At least one usable admin account is required"
      );
    }
  }

  return {
    async listUsers(query: Parameters<AppRepository["listUsers"]>[0]) {
      const page = Math.max(1, Math.trunc(query.page));
      const pageSize = Math.max(1, Math.trunc(query.pageSize));
      const result = await repository.listUsers({
        ...query,
        page,
        pageSize
      });
      return { ...result, page, pageSize };
    },

    async createUser(input: unknown, actor: AuthenticatedActor) {
      try {
        return await repository.createUser(parseMutation(input), actor);
      } catch (error) {
        return mapRepositoryError(error);
      }
    },

    async updateUser(
      userId: string,
      input: unknown,
      actor: AuthenticatedActor
    ) {
      const mutation = parseMutation(input);
      await assertNotLastAdmin(
        userId,
        !mutation.enabled
      );
      try {
        return await repository.updateUser(userId, mutation, actor);
      } catch (error) {
        return mapRepositoryError(error);
      }
    },

    async disableUser(userId: string, actor: AuthenticatedActor) {
      try {
        await assertNotLastAdmin(userId, true);
        return await repository.setUserEnabled(userId, false, actor);
      } catch (error) {
        return mapRepositoryError(error);
      }
    },

    async enableUser(userId: string, actor: AuthenticatedActor) {
      try {
        return await repository.setUserEnabled(userId, true, actor);
      } catch (error) {
        return mapRepositoryError(error);
      }
    },

    async deleteUser(userId: string, actor: AuthenticatedActor) {
      try {
        await assertNotLastAdmin(userId, true);
        const history = await repository.userDeletionHistory?.(userId);
        if (history?.hasHistory) {
          throw new UserAdminConflictError(
            "User has business history and cannot be deleted"
          );
        }
        await repository.deleteUser(userId, actor);
      } catch (error) {
        mapRepositoryError(error);
      }
    },

    async setPassword(
      userId: string,
      input: unknown,
      actor: AuthenticatedActor
    ) {
      const rawPassword = typeof input === "object" && input !== null
        ? (input as { password?: unknown }).password
        : input;
      if (String(rawPassword ?? "") === "") {
        throw new UserAdminValidationError("Password is required");
      }
      let password: string;
      try {
        password = parsePassword(input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new UserAdminValidationError("Password is required");
        }
        throw error;
      }
      try {
        await repository.setUserPassword(
          userId,
          await hashPassword(password),
          actor
        );
      } catch (error) {
        mapRepositoryError(error);
      }
    }
  };
}
