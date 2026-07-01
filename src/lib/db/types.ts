import type { ColumnType, Generated } from "kysely";

export type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;
export type NullableDatabaseTimestamp = ColumnType<
  Date | null,
  Date | string | null,
  Date | string | null
>;
export type JsonColumn<T = unknown> = ColumnType<T, T | string, T | string>;

export interface TicketTable {
  id: string;
  title: string;
  booth_number: string;
  company_name: string;
  company_short_name: string;
  description: string;
  image_urls: JsonColumn<string[]>;
  issue_type: string;
  submitter_id: string;
  submitter_name: string;
  submitter_phone: string | null;
  reporter_person_id: string | null;
  reporter_chat_identity_id: string | null;
  source_conversation_id: string | null;
  status: string;
  accepted_at: NullableDatabaseTimestamp;
  handler_id: string | null;
  handler_name: string | null;
  handler_phone: string | null;
  assignment_group: string | null;
  urge_count: Generated<number>;
  last_urged_at: NullableDatabaseTimestamp;
  urge_level: Generated<number>;
  priority_score: Generated<number>;
  version: Generated<number>;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

export interface TicketReplyTable {
  id: string;
  ticket_id: string;
  author_id: string;
  author_name: string;
  author_phone: string | null;
  role: string;
  body: string;
  image_urls: JsonColumn<string[]>;
  created_at: DatabaseTimestamp;
}

export interface TicketTimelineTable {
  id: string;
  ticket_id: string;
  type: string;
  body: string;
  actor_name: string;
  to_status: string | null;
  created_at: DatabaseTimestamp;
}

/**
 * Kysely table map. Add a table here when its first query is migrated.
 * Keeping the map intentionally incremental avoids pretending unmigrated SQL is typed.
 */
export interface Database {
  tickets: TicketTable;
  ticket_replies: TicketReplyTable;
  ticket_timeline: TicketTimelineTable;
}
