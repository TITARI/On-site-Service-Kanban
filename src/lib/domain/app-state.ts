import type {
  BoothRecord,
  ChatIdentity,
  Conversation,
  InboundMessageRecord,
  OutboundMessage,
  PendingWorkOrderSession,
  Person,
  Ticket
} from "./types";
import type {
  Account,
  AccountCredential,
  AccountRole,
  AccountSession,
  AccessAuditLogEntry,
  AuthBootstrapState,
  Role,
  RolePermission
} from "./access-control";
import type { AppConfig } from "../seed";
import type {
  PersistedUserImportPreview,
  UserImportPreviewRow
} from "./user-import";

export type UserImportJobState = Omit<PersistedUserImportPreview, "rows"> & {
  rows: UserImportPreviewRow[];
  createdAt: string;
  updatedAt: string;
};

export type AppState = {
  booths: BoothRecord[];
  tickets: Ticket[];
  messageRecords: InboundMessageRecord[];
  people?: Person[];
  chatIdentities?: ChatIdentity[];
  conversations?: Conversation[];
  pendingWorkOrderSessions?: PendingWorkOrderSession[];
  outboundMessages?: OutboundMessage[];
  accounts?: Account[];
  accountCredentials?: AccountCredential[];
  roles?: Role[];
  accountRoles?: AccountRole[];
  rolePermissions?: RolePermission[];
  accountSessions?: AccountSession[];
  auditLogs?: AccessAuditLogEntry[];
  authBootstrap?: AuthBootstrapState | null;
  userImportJobs?: UserImportJobState[];
  config: AppConfig;
};
