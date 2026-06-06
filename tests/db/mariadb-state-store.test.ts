import { describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";

function rowDate() {
  return new Date("2026-06-04T01:00:00.000Z");
}

function fakeConnection(): DatabaseConnection {
  return {
    execute: vi.fn(async (sql: string) => {
      if (sql.includes("FROM app_config_versions")) return [[]];
      if (sql.includes("FROM ticket_feedback_users")) return [[]];
      if (sql.includes("FROM tickets")) return [[]];
      if (sql.includes("FROM exhibition_booths")) return [[{
        booth_number: "A01",
        company_name: "Test Company",
        company_short_name: "Test",
        sales_owner: "Owner",
        builder: "Builder"
      }]];
      if (sql.includes("FROM inbound_messages")) return [[{
        id: "message-1",
        channel: "wechat",
        external_message_id: "external-1",
        sender_id: "sender-1",
        sender_name: "Reporter",
        sender_phone: "13800138000",
        sender_group: "现场群",
        text: "A01 网络断了",
        received_at: rowDate(),
        created_at: rowDate(),
        reporter_person_id: "person-1",
        reporter_chat_identity_id: "identity-1",
        source_conversation_id: "conv-1",
        analysis_json: JSON.stringify({ boothNumber: "A01", issueType: "网络", confidence: 0.9, suggestedAction: "create-ticket", reason: "matched" })
      }]];
      if (sql.includes("FROM people")) return [[{
        id: "person-1",
        name: "张三",
        phone: "13800138000",
        role: "handler",
        group_name_snapshot: "搭建组",
        name_conflict: null,
        booth_scope: JSON.stringify(["A01"]),
        enabled: 1,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM chat_identities")) return [[{
        id: "identity-1",
        platform: "wechat",
        external_user_id: "wxid-1",
        display_name: "张三微信",
        is_temporary: 0,
        person_id: "person-1",
        verified_by: "phone",
        verified_at: rowDate(),
        first_seen_at: rowDate(),
        last_seen_at: rowDate()
      }]];
      if (sql.includes("FROM conversations")) return [[{
        id: "conv-1",
        platform: "wechat",
        type: "group",
        external_conversation_id: "现场群",
        title: "现场群",
        default_notify: 1,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM conversation_people")) return [[{
        conversation_id: "conv-1",
        person_id: "person-1"
      }]];
      if (sql.includes("FROM pending_work_order_sessions")) return [[{
        id: "pending-1",
        platform: "wechat",
        conversation_id: "conv-1",
        chat_identity_id: "identity-1",
        original_message_record_id: "message-1",
        draft_text: "A01 网络断了",
        draft_images: JSON.stringify([]),
        identity_group: "搭建组",
        contact_name: "张三",
        contact_phone: "13800138000",
        person_id: "person-1",
        booth_number: "A01",
        issue_type: "网络",
        missing_fields: JSON.stringify(["phone"]),
        created_at: rowDate(),
        updated_at: rowDate(),
        last_prompt_at: rowDate()
      }]];
      if (sql.includes("FROM outbound_messages")) return [[{
        id: "outbound-1",
        channel: "wechat",
        target_conversation_id: "现场群",
        target_chat_identity_id: "identity-1",
        target_name: "现场群",
        text: "请补充信息",
        related_ticket_id: null,
        related_session_id: "pending-1",
        status: "pending",
        retry_count: 0,
        last_error: null,
        claimed_at: null,
        sent_at: null,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM wxauto_agents")) return [[{
        id: "device-a",
        display_name: "Front Desk PC",
        app_version: "0.1.0",
        worker_version: "0.1.0",
        windows_version: "Windows 11",
        wechat_process_state: "running",
        wechat_login_state: "logged_in",
        safety_mode: "strict",
        capabilities_json: JSON.stringify(["text"]),
        last_seen_at: rowDate(),
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM wxauto_releases")) return [[{
        version: "0.2.0",
        channel: "stable",
        file_name: "wxauto-desktop-Setup-0.2.0.exe",
        file_path: "data/wxauto-updates/0.2.0/wxauto-desktop-Setup-0.2.0.exe",
        file_size: 123,
        sha256: "a".repeat(64),
        release_notes: "Test release",
        manifest_json: JSON.stringify({ payload: "{\"version\":\"0.2.0\"}" }),
        signature: "base64-signature",
        published_at: rowDate(),
        created_at: rowDate()
      }]];
      return [[]];
    })
  } as unknown as DatabaseConnection;
}

describe("MariaDbStateStore", () => {
  it("loads admin bootstrap records from MariaDB tables", async () => {
    const data = await new MariaDbStateStore().adminBootstrap(fakeConnection());

    expect(data.booths).toEqual([expect.objectContaining({ boothNumber: "A01" })]);
    expect(data.messageRecords).toEqual([expect.objectContaining({ id: "message-1" })]);
    expect(data.people).toEqual([expect.objectContaining({ id: "person-1", groupName: "搭建组" })]);
    expect(data.chatIdentities).toEqual([expect.objectContaining({ id: "identity-1", personId: "person-1" })]);
    expect(data.conversations).toEqual([expect.objectContaining({ id: "conv-1", linkedPersonIds: ["person-1"] })]);
    expect(data.pendingWorkOrderSessions).toEqual([expect.objectContaining({ id: "pending-1", missingFields: ["phone"] })]);
    expect(data.outboundMessages).toEqual([expect.objectContaining({ id: "outbound-1", status: "pending" })]);
    expect(data.wxautoAgents).toEqual([expect.objectContaining({
      id: "device-a",
      displayName: "Front Desk PC",
      wechatLoginState: "logged_in"
    })]);
    expect(data.wxautoReleases).toEqual([expect.objectContaining({
      version: "0.2.0",
      channel: "stable",
      fileName: "wxauto-desktop-Setup-0.2.0.exe"
    })]);
  });
});
