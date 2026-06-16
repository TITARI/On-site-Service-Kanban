import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import { runMigrations } from "./db-migrate.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(value) {
  return JSON.stringify(value ?? null);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boothRawPayload(booth) {
  const payload = {
    location: cleanText(booth.location),
    area: cleanText(booth.area),
    boothType: cleanText(booth.boothType)
  };
  return Object.values(payload).some(Boolean) ? JSON.stringify(payload) : null;
}

function dateOrNow(value, fallback = new Date()) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("base64url")}`;
}

function ruleSignature(rule) {
  return [
    rule.matchType,
    rule.action,
    rule.issueType ?? "",
    String(rule.priority ?? 0),
    rule.enabled ? "enabled" : "disabled"
  ].join("|");
}

function keywordRuleSetsOf(group) {
  if (group.ruleSets?.length) {
    return group.ruleSets.map((ruleSet, index) => ({
      ...ruleSet,
      sortOrder: ruleSet.sortOrder ?? index + 1,
      terms: (ruleSet.terms ?? [])
        .map((term, termIndex) => ({
          ...term,
          value: String(term.value ?? "").trim(),
          aliases: term.aliases?.map((alias) => String(alias).trim()).filter(Boolean),
          enabled: term.enabled ?? true,
          sortOrder: term.sortOrder ?? termIndex + 1
        }))
        .filter((term) => term.value)
    }));
  }

  const buckets = new Map();
  for (const [index, rule] of (group.rules ?? []).entries()) {
    const key = ruleSignature(rule);
    const bucket = buckets.get(key) ?? { template: rule, terms: [], firstIndex: index };
    bucket.terms.push({
      id: rule.id,
      value: rule.keyword,
      enabled: rule.enabled ?? true,
      sortOrder: index + 1
    });
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values()).map(({ template, terms, firstIndex }, index) => ({
    id: `${group.id}-rule-set-${index + 1}`,
    matchType: template.matchType,
    action: template.action,
    issueType: template.issueType,
    priority: template.priority ?? 0,
    enabled: template.enabled ?? true,
    sortOrder: firstIndex + 1,
    terms
  }));
}

function roleIdForGroup(groupId) {
  return `role-${groupId}`;
}

function groupCanAdmin(group) {
  return group.canAdmin === true;
}

function permissionCodesForGroup(group) {
  return [
    group.canClaim ? "ticket.claim" : undefined,
    group.canProcess ? "ticket.process" : undefined,
    group.canAccept ? "ticket.accept" : undefined,
    groupCanAdmin(group) ? "admin.access" : undefined
  ].filter(Boolean);
}

function groupIdForPerson(person, groups) {
  if (person.groupId && groups.some((group) => group.id === person.groupId)) {
    return person.groupId;
  }
  if (person.groupName) {
    return groups.find((group) => group.enabled && group.name === person.groupName)?.id ?? null;
  }
  return null;
}

function normalizeKeywordGroups(keywordGroups = []) {
  return keywordGroups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description ?? "",
    enabled: group.enabled ?? true,
    ruleSets: keywordRuleSetsOf(group)
  }));
}

async function execute(connection, sql, params = []) {
  await connection.execute(sql, params);
}

async function clearTables(connection) {
  for (const table of [
    "account_sessions",
    "account_credentials",
    "account_roles",
    "role_permissions",
    "auth_bootstrap_state",
    "accounts",
    "roles",
    "ticket_feedback_users",
    "ticket_replies",
    "ticket_timeline",
    "ai_decisions",
    "message_analysis_logs",
    "wechat_order_logs",
    "pending_work_order_sessions",
    "outbound_messages",
    "inbound_messages",
    "conversation_people",
    "conversations",
    "chat_identities",
    "people",
    "tickets",
    "exhibition_booths",
    "exhibitions",
    "assignment_rules",
    "issue_types",
    "message_integrations",
    "ai_model_configs",
    "keyword_match_logs",
    "keyword_terms",
    "keyword_rule_sets",
    "keyword_rules",
    "keyword_groups",
    "user_groups"
  ]) {
    await execute(connection, `DELETE FROM ${table}`);
  }
}

async function importConfig(connection, config, now) {
  for (const group of config.userGroups ?? []) {
    await execute(
      connection,
      `INSERT INTO user_groups (
        id, name, description, can_claim, can_process, can_accept, can_admin, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [group.id, group.name, group.description, group.canClaim, group.canProcess, group.canAccept, groupCanAdmin(group), group.enabled, now, now]
    );
  }

  for (const group of config.userGroups ?? []) {
    await execute(
      connection,
      `INSERT INTO roles (
        id, name, source_group_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [roleIdForGroup(group.id), group.name, group.id, group.enabled, now, now]
    );
    for (const permissionCode of permissionCodesForGroup(group)) {
      await execute(
        connection,
        "INSERT INTO role_permissions (role_id, permission_code, created_at) VALUES (?, ?, ?)",
        [roleIdForGroup(group.id), permissionCode, now]
      );
    }
  }

  await execute(
    connection,
    "INSERT INTO auth_bootstrap_state (id, completed_at, completed_by_account_id) VALUES (?, ?, ?)",
    ["admin", null, null]
  );

  for (const issue of config.issueTypes ?? []) {
    await execute(
      connection,
      `INSERT INTO issue_types (
        id, name, urgency_minutes, priority_weight, assignment_group, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [issue.id, issue.name, issue.urgencyMinutes, issue.priorityWeight, issue.assignmentGroup ?? null, issue.enabled, now, now]
    );
  }

  for (const rule of config.assignmentRules ?? []) {
    await execute(
      connection,
      `INSERT INTO assignment_rules (
        id, booth_pattern, issue_type, handler_id, handler_name, group_name, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rule.id, rule.boothPattern, rule.issueType, rule.handlerId, rule.handlerName, rule.groupName, true, now, now]
    );
  }

  for (const integration of config.messageIntegrations ?? []) {
    await execute(
      connection,
      `INSERT INTO message_integrations (
        id, channel, label, enabled, mcp_server_name, endpoint, secret_env, auto_create_tickets, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        integration.id,
        integration.channel,
        integration.label,
        integration.enabled,
        integration.mcpServerName,
        integration.endpoint ?? null,
        integration.secretEnv ?? null,
        integration.autoCreateTickets,
        now,
        now
      ]
    );
  }

  for (const model of config.aiModels ?? []) {
    await execute(
      connection,
      `INSERT INTO ai_model_configs (
        id, label, provider, endpoint, api_key_env, model_name, timeout_ms, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        model.id,
        model.label,
        model.provider,
        model.endpoint ?? null,
        model.apiKeyEnv ?? null,
        model.modelName,
        model.timeoutMs,
        model.enabled,
        now,
        now
      ]
    );
  }

  for (const group of normalizeKeywordGroups(config.keywordGroups ?? [])) {
    await execute(
      connection,
      "INSERT INTO keyword_groups (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [group.id, group.name, group.description, group.enabled, now, now]
    );
    for (const ruleSet of keywordRuleSetsOf(group)) {
      await execute(
        connection,
        `INSERT INTO keyword_rule_sets (
          id, group_id, match_type, action, issue_type, priority, enabled,
          channels, conditions_json, action_config_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ruleSet.id,
          group.id,
          ruleSet.matchType,
          ruleSet.action,
          ruleSet.issueType ?? null,
          ruleSet.priority,
          ruleSet.enabled,
          ruleSet.channels ? json(ruleSet.channels) : null,
          ruleSet.conditions ? json(ruleSet.conditions) : null,
          ruleSet.actionConfig ? json(ruleSet.actionConfig) : null,
          ruleSet.sortOrder ?? 0,
          now,
          now
        ]
      );
      for (const term of ruleSet.terms ?? []) {
        await execute(
          connection,
          `INSERT INTO keyword_terms (
            id, rule_set_id, term, aliases, enabled, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            term.id,
            ruleSet.id,
            term.value,
            term.aliases?.length ? json(term.aliases) : null,
            term.enabled,
            term.sortOrder ?? 0,
            now,
            now
          ]
        );
        await execute(
          connection,
          `INSERT INTO keyword_rules (
          id, group_id, keyword, match_type, action, issue_type, priority, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            stableId("kw", `${ruleSet.id}|${term.id}|${term.value}`),
            group.id,
            term.value,
            ruleSet.matchType,
            ruleSet.action,
            ruleSet.issueType ?? null,
            ruleSet.priority,
            term.enabled && ruleSet.enabled,
            now,
            now
          ]
        );
      }
    }
  }

  const normalizedConfig = {
    ...config,
    keywordGroups: normalizeKeywordGroups(config.keywordGroups ?? [])
  };
  const version = now.toISOString();
  await execute(
    connection,
    `INSERT INTO app_config_versions (
      id, version, config_json, operator_id, operator_name, change_summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [stableId("config", version), version, json(normalizedConfig), "system", "system", "Import app-state JSON", now]
  );
}

export async function importState(connection, state, sourceName) {
  const now = new Date();
  await clearTables(connection);
  await importConfig(connection, state.config ?? {}, now);
  const userGroups = state.config?.userGroups ?? [];

  await execute(
    connection,
    "INSERT INTO exhibitions (id, name, status, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["current", "当前展览", "active", null, null, now, now]
  );

  for (const booth of state.booths ?? []) {
    await execute(
      connection,
      `INSERT INTO exhibition_booths (
        id, exhibition_id, booth_number, company_name, company_short_name, sales_owner, builder,
        contact_name, contact_phone, raw_payload, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("booth", booth.boothNumber),
        "current",
        booth.boothNumber,
        booth.companyName,
        booth.companyShortName,
        booth.salesOwner,
        booth.builder,
        null,
        null,
        boothRawPayload(booth),
        true,
        now,
        now
      ]
    );
  }

  for (const person of state.people ?? []) {
    const groupId = groupIdForPerson(person, userGroups);
    const groupName = groupId
      ? userGroups.find((group) => group.id === groupId)?.name ?? person.groupName
      : person.groupName;
    await execute(
      connection,
      `INSERT INTO people (
        id, name, phone, role, group_id, group_name_snapshot, name_conflict, booth_scope, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        person.id,
        person.name,
        person.phone,
        person.role,
        groupId,
        groupName,
        person.nameConflict ? json(person.nameConflict) : null,
        person.boothScope ? json(person.boothScope) : null,
        person.enabled,
        dateOrNow(person.createdAt, now),
        dateOrNow(person.updatedAt, now)
      ]
    );
  }

  for (const person of state.people ?? []) {
    const groupId = groupIdForPerson(person, userGroups);
    const accountId = `account-${person.id}`;
    await execute(
      connection,
      `INSERT INTO accounts (
        id, person_id, login_name, enabled, auth_version, last_login_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        person.id,
        person.phone,
        person.enabled,
        1,
        null,
        dateOrNow(person.createdAt, now),
        dateOrNow(person.updatedAt, now)
      ]
    );
    if (!groupId) continue;
    await execute(
      connection,
      "INSERT INTO account_roles (account_id, role_id, created_at) VALUES (?, ?, ?)",
      [accountId, roleIdForGroup(groupId), now]
    );
  }

  for (const identity of state.chatIdentities ?? []) {
    await execute(
      connection,
      `INSERT INTO chat_identities (
        id, platform, external_user_id, display_name, is_temporary, person_id, verified_by,
        verified_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.id,
        identity.platform,
        identity.externalUserId,
        identity.displayName,
        Boolean(identity.isTemporary),
        identity.personId ?? null,
        identity.verifiedBy ?? null,
        identity.verifiedAt ? dateOrNow(identity.verifiedAt, now) : null,
        dateOrNow(identity.firstSeenAt, now),
        dateOrNow(identity.lastSeenAt, now)
      ]
    );
  }

  for (const conversation of state.conversations ?? []) {
    await execute(
      connection,
      `INSERT INTO conversations (
        id, platform, type, external_conversation_id, title, default_notify, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.platform,
        conversation.type,
        conversation.externalConversationId,
        conversation.title ?? null,
        conversation.defaultNotify,
        dateOrNow(conversation.createdAt, now),
        dateOrNow(conversation.updatedAt, now)
      ]
    );
    for (const personId of conversation.linkedPersonIds ?? []) {
      await execute(
        connection,
        "INSERT INTO conversation_people (conversation_id, person_id, created_at) VALUES (?, ?, ?)",
        [conversation.id, personId, now]
      );
    }
  }

  for (const ticket of state.tickets ?? []) {
    await execute(
      connection,
      `INSERT INTO tickets (
        id, title, booth_number, company_name, company_short_name, description, image_urls, issue_type,
        submitter_id, submitter_name, submitter_phone, reporter_person_id, reporter_chat_identity_id,
        source_conversation_id, status, accepted_at, handler_id, handler_name, handler_phone,
        assignment_group, urge_count, last_urged_at, urge_level, priority_score, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket.id,
        ticket.title,
        ticket.boothNumber,
        ticket.companyName,
        ticket.companyShortName,
        ticket.description,
        json(ticket.imageUrls),
        ticket.issueType,
        ticket.submitterId,
        ticket.submitterName,
        ticket.submitterPhone ?? null,
        ticket.reporterPersonId ?? null,
        ticket.reporterChatIdentityId ?? null,
        ticket.sourceConversationId ?? null,
        ticket.status,
        ticket.acceptedAt ? dateOrNow(ticket.acceptedAt, now) : null,
        ticket.handlerId ?? null,
        ticket.handlerName ?? null,
        ticket.handlerPhone ?? null,
        ticket.assignmentGroup ?? null,
        ticket.urgeCount,
        ticket.lastUrgedAt ? dateOrNow(ticket.lastUrgedAt, now) : null,
        ticket.urgeLevel,
        ticket.priorityScore,
        dateOrNow(ticket.createdAt, now),
        dateOrNow(ticket.updatedAt, now)
      ]
    );

    for (const feedback of ticket.feedbackUsers ?? []) {
      await execute(
        connection,
        "INSERT INTO ticket_feedback_users (id, ticket_id, user_id, user_name, phone, feedback_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          stableId("feedback", `${ticket.id}:${feedback.userId}`),
          ticket.id,
          feedback.userId,
          feedback.userName,
          feedback.phone ?? null,
          dateOrNow(feedback.feedbackAt, now)
        ]
      );
    }

    for (const reply of ticket.replies ?? []) {
      await execute(
        connection,
        `INSERT INTO ticket_replies (
          id, ticket_id, author_id, author_name, author_phone, role, body, image_urls, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reply.id,
          ticket.id,
          reply.authorId,
          reply.authorName,
          reply.authorPhone ?? null,
          reply.role,
          reply.body,
          json(reply.imageUrls),
          dateOrNow(reply.createdAt, now)
        ]
      );
    }

    for (const item of ticket.timeline ?? []) {
      await execute(
        connection,
        "INSERT INTO ticket_timeline (id, ticket_id, type, body, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [item.id, ticket.id, item.type, item.body, item.actorName, dateOrNow(item.createdAt, now)]
      );
    }

    for (const [index, decision] of (ticket.aiDecisions ?? []).entries()) {
      await execute(
        connection,
        `INSERT INTO ai_decisions (
          id, ticket_id, model_id, scenario, confidence, action, issue_type, matched_ticket_id,
          suggestion, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stableId("decision", `${ticket.id}:${index}`),
          ticket.id,
          decision.modelId,
          decision.scenario,
          decision.confidence,
          decision.action,
          decision.issueType ?? null,
          decision.matchedTicketId ?? null,
          decision.suggestion ?? null,
          decision.latencyMs,
          dateOrNow(ticket.updatedAt, now)
        ]
      );
    }
  }

  for (const record of state.messageRecords ?? []) {
    await execute(
      connection,
      `INSERT INTO inbound_messages (
        id, channel, external_message_id, sender_id, sender_name, sender_phone, sender_group, text,
        image_urls, received_at, created_at, reporter_person_id, reporter_chat_identity_id,
        source_conversation_id, raw_payload, analysis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.channel,
        record.externalMessageId ?? null,
        record.senderId ?? null,
        record.senderName,
        record.senderPhone ?? null,
        record.senderGroup ?? null,
        record.text,
        json(record.imageUrls),
        dateOrNow(record.receivedAt, now),
        dateOrNow(record.createdAt, now),
        record.reporterPersonId ?? null,
        record.reporterChatIdentityId ?? null,
        record.sourceConversationId ?? null,
        record.raw ? json(record.raw) : null,
        json(record.analysis)
      ]
    );
    await execute(
      connection,
      `INSERT INTO message_analysis_logs (
        id, inbound_message_id, booth_number, issue_type, confidence, suggested_action, matched_ticket_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("analysis", record.id),
        record.id,
        record.analysis?.boothNumber ?? null,
        record.analysis?.issueType ?? null,
        record.analysis?.confidence ?? 0,
        record.analysis?.suggestedAction ?? "ignore",
        record.analysis?.matchedTicketId ?? null,
        record.analysis?.reason ?? "",
        dateOrNow(record.createdAt, now)
      ]
    );
    await execute(
      connection,
      `INSERT INTO wechat_order_logs (
        id, inbound_message_id, channel, action, ticket_id, session_id, summary, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("wechat-log", record.id),
        record.id,
        record.channel,
        record.analysis?.suggestedAction ?? "ignore",
        record.analysis?.matchedTicketId ?? null,
        null,
        record.analysis?.reason ?? "",
        record.analysis?.suggestedAction === "ignore" ? "ignored" : "processed",
        dateOrNow(record.createdAt, now)
      ]
    );
  }

  for (const session of state.pendingWorkOrderSessions ?? []) {
    await execute(
      connection,
      `INSERT INTO pending_work_order_sessions (
        id, platform, conversation_id, chat_identity_id, original_message_record_id, draft_text,
        draft_images, identity_group, contact_name, contact_phone, person_id, booth_number,
        issue_type, missing_fields, created_at, updated_at, last_prompt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.platform,
        session.conversationId,
        session.chatIdentityId,
        session.originalMessageRecordId ?? null,
        session.draftText,
        json(session.draftImages),
        session.identityGroup ?? null,
        session.contactName ?? null,
        session.contactPhone ?? null,
        session.personId ?? null,
        session.boothNumber ?? null,
        session.issueType ?? null,
        json(session.missingFields),
        dateOrNow(session.createdAt, now),
        dateOrNow(session.updatedAt, now),
        session.lastPromptAt ? dateOrNow(session.lastPromptAt, now) : null
      ]
    );
  }

  for (const message of state.outboundMessages ?? []) {
    await execute(
      connection,
      `INSERT INTO outbound_messages (
        id, channel, target_conversation_id, target_chat_identity_id, target_name, text,
        related_ticket_id, related_session_id, status, retry_count, last_error, claimed_at,
        sent_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.channel,
        message.targetConversationId ?? null,
        message.targetChatIdentityId ?? null,
        message.targetName,
        message.text,
        message.relatedTicketId ?? null,
        message.relatedSessionId ?? null,
        message.status,
        message.retryCount,
        message.lastError ?? null,
        message.claimedAt ? dateOrNow(message.claimedAt, now) : null,
        message.sentAt ? dateOrNow(message.sentAt, now) : null,
        dateOrNow(message.createdAt, now),
        dateOrNow(message.updatedAt, now)
      ]
    );
  }

  const jobId = stableId("import", `${sourceName}:${now.toISOString()}`);
  const totalRows = (state.booths ?? []).length + (state.tickets ?? []).length + (state.messageRecords ?? []).length;
  await execute(
    connection,
    `INSERT INTO import_jobs (
      id, type, source_name, status, total_rows, success_rows, failed_rows, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [jobId, "app-state", sourceName, "completed", totalRows, totalRows, 0, now, now]
  );
  await execute(
    connection,
    "INSERT INTO import_job_rows (id, job_id, `row_number`, status, message, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [stableId("import-row", jobId), jobId, 1, "success", "Imported JSON state", json({ totalRows }), now]
  );
  await execute(
    connection,
    "INSERT INTO audit_logs (id, actor_id, actor_name, action, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [stableId("audit", jobId), "system", "system", "import.app_state", "import_job", jobId, json({ sourceName, totalRows }), now]
  );
}

export async function importAppState({
  databaseUrl = process.env.DATABASE_URL,
  statePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, "data", "app-state.json")
} = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await runMigrations({ databaseUrl });
  const state = JSON.parse(await readFile(statePath, "utf-8"));
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 1, waitForConnections: true, timezone: "Z" });
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await importState(connection, state, statePath);
    await connection.commit();
    return statePath;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  importAppState()
    .then((statePath) => {
      console.log(`Imported app state from ${statePath}.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
