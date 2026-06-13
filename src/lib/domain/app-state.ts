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
  AuthBootstrapState,
  Role,
  RolePermission
} from "./access-control";
import type { AppConfig } from "../seed";

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
  authBootstrap?: AuthBootstrapState | null;
  config: AppConfig;
};
