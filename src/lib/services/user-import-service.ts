import type {
  AuthenticatedActor,
  UserListItem
} from "../domain/access-control";
import type { ChatIdentity, MessageChannel } from "../domain/types";
import type {
  UserImportCommitInput,
  UserImportCommitResult,
  UserImportDecisionPatch,
  UserImportPreviewInput,
  UserImportPreviewRow,
  UserImportReportRow
} from "../domain/user-import";
import {
  STALE_IMPORT_MESSAGE,
  assertValidUserImportDecision
} from "../domain/user-import";
import type { AppRepository } from "../repositories/app-repository";

type CommitRepository = AppRepository & {
  loadImportJob?: (
    jobId: string,
    actor: AuthenticatedActor
  ) => Promise<UserImportCommitInput>;
  currentUserVersion?: (
    row: UserImportPreviewRow,
    actor: AuthenticatedActor
  ) => Promise<string | undefined>;
  applyUserImport?: (
    input: UserImportCommitInput,
    actor: AuthenticatedActor
  ) => Promise<UserImportCommitResult>;
  markUserImportRowsStale?: (
    jobId: string,
    rowIds: string[],
    actor: AuthenticatedActor
  ) => Promise<void>;
  userImportReport?: (
    jobId: string,
    actor: AuthenticatedActor
  ) => Promise<UserImportReportRow[]>;
};

type IdentityBaseline =
  NonNullable<NonNullable<UserImportPreviewRow["baseline"]>["identities"]>[MessageChannel];

async function exactUserByPhone(repository: AppRepository, phone: string) {
  const { users } = await repository.listUsers({
    search: phone,
    page: 1,
    pageSize: 10
  });
  return users.find((user) => user.phone === phone);
}

function selectedRows(rows: UserImportPreviewRow[]) {
  return rows.filter((row) =>
    row.decision &&
    row.decision.action !== "skip"
  );
}

function currentActions(existingUser: UserListItem | undefined) {
  return existingUser ? ["overwrite", "skip"] : ["add", "skip"];
}

function identityChanged(
  current: ChatIdentity | undefined,
  baseline: IdentityBaseline | undefined
) {
  if (!baseline) return Boolean(current?.personId);
  return (
    !current ||
    current.id !== baseline.identityId ||
    current.personId !== baseline.personId ||
    current.lastSeenAt !== baseline.updatedAt
  );
}

function confirmedRebind(
  row: UserImportPreviewRow,
  platform: MessageChannel
) {
  if (!row.decision || row.decision.action === "skip") return false;
  return platform === "wechat"
    ? row.decision.confirmWechatRebind
    : row.decision.confirmWecomRebind;
}

async function legacyVersionChanged(
  repository: AppRepository,
  row: UserImportPreviewRow,
  actor: AuthenticatedActor
) {
  const currentUserVersion = (repository as CommitRepository).currentUserVersion;
  if (!currentUserVersion || row.baseline?.person) return false;
  const version = await currentUserVersion(row, actor);
  return (
    version !== undefined &&
    version !== "same" &&
    version !== "missing"
  );
}

async function rowIsStale(
  repository: AppRepository,
  row: UserImportPreviewRow,
  actor: AuthenticatedActor
) {
  const value = row.value;
  const decision = row.decision;
  if (!value || !decision) return true;
  if (await legacyVersionChanged(repository, row, actor)) return true;

  const currentUser = await exactUserByPhone(repository, value.phone);
  if (row.baseline?.person) {
    if (
      !currentUser ||
      currentUser.personId !== row.baseline.person.personId ||
      currentUser.updatedAt !== row.baseline.person.updatedAt
    ) {
      return true;
    }
  }

  const liveActions = currentActions(currentUser);
  if (!liveActions.includes(decision.action)) return true;

  const group = (await repository.getConfig()).userGroups?.find(
    (item) => item.id === value.groupId
  );
  if (
    !group?.enabled ||
    (row.baseline?.group &&
      (
        group.id !== row.baseline.group.groupId ||
        group.enabled !== row.baseline.group.enabled
      ))
  ) {
    return true;
  }

  for (const [platform, externalUserId] of [
    ["wechat", value.wechatExternalUserId],
    ["wecom", value.wecomExternalUserId]
  ] as const) {
    if (!externalUserId) continue;
    const baseline = row.baseline?.identities?.[platform];
    const identity = await repository.identityByExternalId(
      platform,
      externalUserId
    );
    if (identityChanged(identity, baseline)) return true;
    if (
      row.conflicts.includes(`${platform}-occupied`) &&
      !confirmedRebind(row, platform)
    ) {
      return true;
    }
    if (
      identity?.personId &&
      currentUser?.personId &&
      identity.personId !== currentUser.personId &&
      !row.conflicts.includes(`${platform}-occupied`)
    ) {
      return true;
    }
  }

  return false;
}

async function revalidateRows(
  repository: AppRepository,
  job: UserImportCommitInput,
  actor: AuthenticatedActor
) {
  const selected = selectedRows(job.rows);
  const staleRowIds: string[] = [];
  for (const row of selected) {
    if (!row.value || !row.decision) {
      staleRowIds.push(row.id);
      continue;
    }
    try {
      assertValidUserImportDecision(row, row.decision);
    } catch {
      staleRowIds.push(row.id);
    }
  }

  for (const row of selected) {
    if (staleRowIds.includes(row.id)) continue;
    if (await rowIsStale(repository, row, actor)) staleRowIds.push(row.id);
  }

  if (staleRowIds.length) {
    const marker = (repository as CommitRepository).markUserImportRowsStale;
    await marker?.(job.jobId, staleRowIds, actor);
    throw new Error(STALE_IMPORT_MESSAGE);
  }
  return selected;
}

export async function commitUserImport(
  repository: AppRepository,
  jobId: string,
  actor: AuthenticatedActor
): Promise<UserImportCommitResult> {
  const commitRepository = repository as CommitRepository;
  const job = commitRepository.loadImportJob
    ? await commitRepository.loadImportJob(jobId, actor)
    : await repository.getUserImportJobRows(jobId, actor);
  const selected = await revalidateRows(repository, job, actor);
  if (!commitRepository.applyUserImport) {
    throw new Error("当前存储不支持提交用户导入");
  }
  return await commitRepository.applyUserImport({
    ...job,
    rows: selected
  }, actor);
}

export function createUserImportService(repository: AppRepository) {
  return {
    preview: (
      input: UserImportPreviewInput,
      actor: AuthenticatedActor
    ) => repository.saveUserImportPreview(input, actor),
    rows: (
      jobId: string,
      actor: AuthenticatedActor
    ) => repository.getUserImportJobRows(jobId, actor),
    saveDecisions: (
      jobId: string,
      decisions: UserImportDecisionPatch[],
      actor: AuthenticatedActor
    ) => repository.saveUserImportDecisions(jobId, decisions, actor),
    commit: (
      jobId: string,
      actor: AuthenticatedActor
    ) => commitUserImport(repository, jobId, actor),
    report: (
      jobId: string,
      actor: AuthenticatedActor
    ) => {
      const commitRepository = repository as CommitRepository;
      if (!commitRepository.userImportReport) {
        throw new Error("当前存储不支持导出用户导入报告");
      }
      return commitRepository.userImportReport(jobId, actor);
    }
  };
}
