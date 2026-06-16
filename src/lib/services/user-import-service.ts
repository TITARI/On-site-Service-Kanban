import type {
  AuthenticatedActor,
  UserListItem
} from "../domain/access-control";
import type {
  UserImportCommitInput,
  UserImportCommitResult,
  UserImportDecisionPatch,
  UserImportPreviewInput,
  UserImportPreviewRow,
  UserImportReportRow
} from "../domain/user-import";
import {
  assertValidUserImportDecision,
  previewUserImport
} from "../domain/user-import";
import type { AppRepository } from "../repositories/app-repository";

const STALE_IMPORT_MESSAGE = "导入数据已变化，请重新处理冲突";

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
  userImportReport?: (
    jobId: string,
    actor: AuthenticatedActor
  ) => Promise<UserImportReportRow[]>;
};

async function exactUserByPhone(repository: AppRepository, phone: string) {
  const { users } = await repository.listUsers({
    search: phone,
    page: 1,
    pageSize: 10
  });
  return users.find((user) => user.phone === phone);
}

function previewVersion(row: UserImportPreviewRow, user: UserListItem | undefined) {
  if (!row.value) return undefined;
  return user?.updatedAt ?? "missing";
}

async function computedCurrentVersion(
  repository: AppRepository,
  row: UserImportPreviewRow,
  actor: AuthenticatedActor
) {
  const customVersion = (repository as CommitRepository).currentUserVersion;
  if (customVersion) return await customVersion(row, actor);
  if (!row.value) return undefined;
  return previewVersion(row, await exactUserByPhone(repository, row.value.phone));
}

function selectedRows(rows: UserImportPreviewRow[]) {
  return rows.filter((row) =>
    row.decision &&
    row.decision.action !== "skip"
  );
}

async function revalidateRows(
  repository: AppRepository,
  job: UserImportCommitInput,
  actor: AuthenticatedActor
) {
  const selected = selectedRows(job.rows);
  for (const row of selected) {
    if (!row.value || !row.decision) throw new Error(STALE_IMPORT_MESSAGE);
    try {
      assertValidUserImportDecision(row, row.decision);
    } catch {
      throw new Error(STALE_IMPORT_MESSAGE);
    }
  }

  const canRepreview = selected.every((row) =>
    row.value?.phone &&
    JSON.stringify(row.raw).includes(row.value.phone)
  );
  const livePreview = canRepreview
    ? await previewUserImport(
        repository,
        {
          sourceName: job.sourceName,
          sourceHash: job.sourceHash,
          rows: job.rows.map((row) => row.raw)
        },
        actor
      )
    : undefined;
  for (const row of selected) {
    const value = row.value;
    const decision = row.decision;
    if (!value || !decision) throw new Error(STALE_IMPORT_MESSAGE);
    const liveRow = livePreview?.rows[row.rowNumber - 1];
    if (
      liveRow &&
      (
        !liveRow.value ||
        liveRow.category !== row.category ||
        liveRow.allowedActions.join("|") !== row.allowedActions.join("|") ||
        liveRow.conflicts.join("|") !== row.conflicts.join("|")
      )
    ) {
      throw new Error(STALE_IMPORT_MESSAGE);
    }

    const currentVersion = await computedCurrentVersion(repository, row, actor);
    if (
      currentVersion !== undefined &&
      currentVersion !== "same" &&
      currentVersion !== "missing"
    ) {
      throw new Error(STALE_IMPORT_MESSAGE);
    }

    const group = (await repository.getConfig()).userGroups?.find(
      (item) => item.id === value.groupId
    );
    if (!group?.enabled) throw new Error(STALE_IMPORT_MESSAGE);

    for (const [platform, externalUserId, confirmed] of [
      ["wechat", value.wechatExternalUserId, decision.confirmWechatRebind],
      ["wecom", value.wecomExternalUserId, decision.confirmWecomRebind]
    ] as const) {
      if (!externalUserId) continue;
      const identity = await repository.identityByExternalId(
        platform,
        externalUserId
      );
      if (
        identity?.personId &&
        identity.personId !== liveRow?.value?.phone &&
        row.conflicts.includes(`${platform}-occupied`) &&
        confirmed !== true
      ) {
        throw new Error(STALE_IMPORT_MESSAGE);
      }
    }
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
    throw new Error("User import commit is not supported by this repository");
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
        throw new Error("User import report is not supported by this repository");
      }
      return commitRepository.userImportReport(jobId, actor);
    }
  };
}
