import type {
  AuthenticatedActor
} from "../domain/access-control";
import type {
  UserImportDecisionPatch,
  UserImportPreviewInput
} from "../domain/user-import";
import type { AppRepository } from "../repositories/app-repository";

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
    ) => repository.saveUserImportDecisions(jobId, decisions, actor)
  };
}
