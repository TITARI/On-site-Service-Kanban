# 数据库架构设计

## 背景

当前系统使用 `data/app-state.json` 保存运行时状态。这个方式适合早期演示和单人本地验证，但现在系统目标已经扩展为：

- 微信/企微消息自动进入系统。
- 微信消息可触发建单、催单、追问和回执。
- 后台需要微信下工单日志、集成配置、关键词配置、展览数据、工单详细设置。
- 后台配置需要保存、追踪、审计和回滚基础。

这些能力会产生持续增长的结构化数据，并且需要按时间、展位号、问题类型、关键词、状态、处理动作筛选。继续把所有数据写入单个 JSON 文件，会在并发写入、查询性能、审计、数据恢复和后续扩展上形成瓶颈。

## 结论

系统应引入关系型数据库，推荐使用 **MariaDB** 作为主存储。

理由：

- 项目目录中已经包含 MariaDB Windows 包，部署方向与本地 Windows 服务兼容。
- 工单、消息、人员、展位、配置、日志之间关系明确，适合关系型建模。
- 后台大量查询是筛选、排序、分页和关联查询，数据库比 JSON 文件更合适。
- 未来可以通过事务保证微信消息处理、建单、日志写入的一致性。
- 配置变更、导入记录和操作审计天然适合追加式表结构。

Redis 暂不作为第一阶段必需依赖。后续如果需要任务队列、分布式锁、发送重试调度或临时会话缓存，再引入 Redis。

## 架构目标

- MariaDB 成为运行时主数据源。
- `data/app-state.json` 只作为迁移来源、开发兜底和一次性导入数据。
- 业务服务不直接读写 JSON 或 SQL，而是通过 Repository 层访问数据。
- 后台配置写入数据库，并生成配置版本和审计日志。
- 微信消息处理、工单创建、追问会话、出站通知和日志写入使用事务边界。
- 展览数据、关键词配置、工单规则、集成配置都具备独立的数据模型。

## 非目标

- 第一阶段不引入复杂多租户。
- 第一阶段不做分库分表。
- 第一阶段不做全文检索引擎。关键词筛选先用结构化字段和必要索引解决。
- 第一阶段不强制 Redis。消息重试和队列可以先用数据库状态表表达。
- 第一阶段不迁移到云数据库，仍优先支持 Windows 本地部署。

## 总体结构

```text
Next.js App
  App Router Pages
  API Routes
    Service Layer
      TicketService
      MessageIntakeService
      WechatWatchtowerService
      ConfigService
      ExhibitionDataService
      AuditService
    Repository Layer
      TicketRepository
      MessageRepository
      ConfigRepository
      ExhibitionRepository
      AuditRepository
    Database Adapter
      MariaDB
```

业务服务只依赖 Repository 接口。这样可以先保留 JSON 实现作为过渡，再逐步切换到 MariaDB 实现。

## 数据域

### 展览数据

原“主数据”在后台统一改名为“展览数据”。展览数据描述当前展会的展位、公司、业务员、搭建商和后续可能的联系人。

核心用途：

- 微信消息识别展位号。
- 工单标题生成。
- 自动派单规则匹配。
- 后台按展位、公司、搭建商查询。

### 工单

工单是现场协同的主业务对象。工单包括状态、处理人、处理组、优先级、催单、回复、时间线和 AI 决策。

核心用途：

- 移动端提交和查看。
- 微信消息自动建单、催单、合并。
- 后台查询和规则分析。

### 微信下单

微信下单不只是消息记录，而是从“收到消息”到“识别、追问、建单、回执”的完整链路。

核心用途：

- 入站日志。
- 识别日志。
- 追问日志。
- 建单结果日志。
- 出站通知日志。
- 失败排查。

### 组织与身份

组织与身份用于把系统人员、微信身份、会话、处理组关联起来。

核心用途：

- 微信用户注册和绑定。
- 处理组通知。
- 权限控制。
- 后台人员管理。

### 工单设置

工单设置描述系统如何识别、派单、催单、流转和回执。

核心用途：

- 问题类型。
- 状态流转。
- 派单规则。
- SLA/催单规则。
- 微信回执规则。
- 字段要求。

### 集成配置与关键词

集成配置描述微信、企微、AI 等外部接口。关键词配置描述微信消息如何被判断为现场诉求，以及如何映射到问题类型。

核心用途：

- 微信/企微 MCP 接入。
- 自动建单开关。
- 关键词命中。
- 问题类型识别。
- 忽略普通聊天。

### 审计与运维

审计与运维记录后台操作、配置变更、导入任务、异常和系统事件。

核心用途：

- 追踪配置改动。
- 排查微信自动下单。
- 查看导入结果。
- 追溯后台操作。

## 表设计

### exhibitions

展会主表。第一阶段可以只有一个当前展会，但仍保留展会维度，避免后续多展会改表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 展会 ID |
| name | varchar(160) | 展会名称 |
| status | varchar(32) | draft, active, archived |
| starts_at | datetime null | 开始时间 |
| ends_at | datetime null | 结束时间 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_exhibitions_status(status)`

### exhibition_booths

展览数据中的展位记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 展位记录 ID |
| exhibition_id | varchar(64) | 所属展会 |
| booth_number | varchar(64) | 展位号 |
| company_name | varchar(255) | 公司名称 |
| company_short_name | varchar(120) null | 公司简称 |
| sales_owner | varchar(120) null | 业务员 |
| builder | varchar(160) null | 搭建商 |
| contact_name | varchar(120) null | 展商联系人 |
| contact_phone | varchar(64) null | 展商联系电话 |
| raw_payload | json null | 原始导入行 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

约束与索引：

- `uniq_booth_per_exhibition(exhibition_id, booth_number)`
- `idx_booths_company(company_name)`
- `idx_booths_builder(builder)`
- `idx_booths_sales_owner(sales_owner)`

### user_groups

用户分组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 分组 ID |
| name | varchar(120) | 分组名称 |
| description | varchar(255) | 说明 |
| can_claim | boolean | 可认领 |
| can_process | boolean | 可处理 |
| can_accept | boolean | 可验收 |
| can_admin | boolean | 可进入后台配置 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `uniq_user_groups_name(name)`

### people

人员表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 人员 ID |
| name | varchar(120) | 姓名 |
| phone | varchar(64) | 手机号 |
| role | varchar(32) | reporter, handler, manager, admin |
| group_id | varchar(64) null | 分组 ID |
| group_name_snapshot | varchar(120) null | 分组名快照 |
| booth_scope | json null | 可处理展位范围 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

约束与索引：

- `uniq_people_phone(phone)`
- `idx_people_group(group_id)`
- `idx_people_role(role)`

### chat_identities

微信/企微身份。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 身份 ID |
| platform | varchar(16) | wechat, wecom |
| external_user_id | varchar(160) | 外部用户 ID |
| display_name | varchar(160) | 微信展示名 |
| is_temporary | boolean | 是否临时身份 |
| person_id | varchar(64) null | 绑定人员 |
| verified_by | varchar(32) null | phone, admin, import |
| verified_at | datetime null | 验证时间 |
| first_seen_at | datetime | 首次出现 |
| last_seen_at | datetime | 最近出现 |

约束与索引：

- `uniq_chat_identity(platform, external_user_id)`
- `idx_chat_identity_person(person_id)`
- `idx_chat_identity_seen(last_seen_at)`

### conversations

微信/企微会话。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 会话 ID |
| platform | varchar(16) | wechat, wecom |
| type | varchar(16) | direct, group |
| external_conversation_id | varchar(160) | 外部会话 ID |
| title | varchar(160) null | 会话标题 |
| default_notify | boolean | 默认通知 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

约束与索引：

- `uniq_conversation(platform, external_conversation_id)`

### conversation_people

会话与人员关系表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| conversation_id | varchar(64) | 会话 ID |
| person_id | varchar(64) | 人员 ID |
| created_at | datetime | 创建时间 |

约束：

- `pk_conversation_people(conversation_id, person_id)`

### tickets

工单主表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 工单 ID |
| exhibition_id | varchar(64) null | 展会 ID |
| title | varchar(255) | 标题 |
| booth_number | varchar(64) | 展位号 |
| booth_id | varchar(64) null | 展位记录 ID |
| company_name | varchar(255) | 公司名称 |
| company_short_name | varchar(120) null | 公司简称 |
| description | text | 问题描述 |
| image_urls | json | 图片 |
| issue_type_id | varchar(64) null | 问题类型 ID |
| issue_type_name | varchar(120) | 问题类型名快照 |
| submitter_id | varchar(64) | 提交人 ID |
| submitter_name | varchar(120) | 提交人姓名快照 |
| submitter_phone | varchar(64) null | 提交人电话快照 |
| reporter_person_id | varchar(64) null | 微信上报人员 |
| reporter_chat_identity_id | varchar(64) null | 微信身份 |
| source_conversation_id | varchar(64) null | 来源会话 |
| status | varchar(32) | 工单状态 |
| accepted_at | datetime null | 受理时间 |
| handler_id | varchar(64) null | 处理人 |
| handler_name | varchar(120) null | 处理人快照 |
| handler_phone | varchar(64) null | 处理人电话快照 |
| assignment_group_id | varchar(64) null | 处理组 |
| assignment_group_name | varchar(120) null | 处理组名快照 |
| urge_count | int | 催单次数 |
| last_urged_at | datetime null | 最近催单时间 |
| urge_level | int | 催单级别 |
| priority_score | int | 优先级得分 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_tickets_status(status)`
- `idx_tickets_booth(booth_number)`
- `idx_tickets_issue(issue_type_id)`
- `idx_tickets_handler(handler_id)`
- `idx_tickets_created(created_at)`
- `idx_tickets_source(source_conversation_id)`

### ticket_feedback_users

工单反馈用户列表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 记录 ID |
| ticket_id | varchar(64) | 工单 ID |
| user_id | varchar(64) | 用户 ID |
| user_name | varchar(120) | 用户名快照 |
| phone | varchar(64) null | 电话快照 |
| feedback_at | datetime | 反馈时间 |

索引：

- `idx_feedback_ticket(ticket_id)`
- `idx_feedback_user(user_id)`

### ticket_replies

工单回复。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 回复 ID |
| ticket_id | varchar(64) | 工单 ID |
| author_id | varchar(64) | 作者 ID |
| author_name | varchar(120) | 作者名快照 |
| author_phone | varchar(64) null | 作者电话快照 |
| role | varchar(32) | member, handler, system-ai |
| body | text | 回复内容 |
| image_urls | json | 图片 |
| created_at | datetime | 创建时间 |

索引：

- `idx_replies_ticket(ticket_id, created_at)`

### ticket_timeline

工单时间线。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 时间线 ID |
| ticket_id | varchar(64) | 工单 ID |
| type | varchar(64) | submitted, assigned, status-changed, urged, reply, ai-suggestion, receipt |
| body | text | 内容 |
| actor_name | varchar(120) | 操作人快照 |
| created_at | datetime | 创建时间 |

索引：

- `idx_timeline_ticket(ticket_id, created_at)`

### ai_decisions

AI 决策记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 决策 ID |
| ticket_id | varchar(64) null | 工单 ID |
| message_id | varchar(64) null | 入站消息 ID |
| model_id | varchar(32) | fast, smart |
| scenario | varchar(32) | classify, dedupe, escalation |
| confidence | decimal(5,4) | 置信度 |
| action | varchar(64) | create, urge, manual-review, classify |
| issue_type | varchar(120) null | 问题类型 |
| matched_ticket_id | varchar(64) null | 命中工单 |
| suggestion | text null | 建议 |
| latency_ms | int | 耗时 |
| created_at | datetime | 创建时间 |

索引：

- `idx_ai_ticket(ticket_id)`
- `idx_ai_message(message_id)`
- `idx_ai_created(created_at)`

### inbound_messages

微信/企微入站消息。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 消息 ID |
| channel | varchar(16) | wechat, wecom |
| external_message_id | varchar(160) null | 外部消息 ID |
| sender_id | varchar(160) null | 外部发送人 ID |
| sender_name | varchar(160) | 发送人 |
| sender_phone | varchar(64) null | 电话 |
| sender_group | varchar(160) null | 群/来源 |
| text | text | 文本 |
| image_urls | json | 图片 |
| received_at | datetime | 接收时间 |
| created_at | datetime | 入库时间 |
| reporter_person_id | varchar(64) null | 人员 ID |
| reporter_chat_identity_id | varchar(64) null | 身份 ID |
| source_conversation_id | varchar(64) null | 会话 ID |
| raw_payload | json null | 原始消息 |

约束与索引：

- `uniq_inbound_external(channel, external_message_id)`，当 external_message_id 不为空时去重。
- `idx_inbound_received(received_at)`
- `idx_inbound_sender(sender_id)`
- `idx_inbound_conversation(source_conversation_id)`

### message_analysis_logs

微信下单识别日志。它把当前 `InboundMessageRecord.analysis` 从消息记录中拆出来，便于筛选和审计。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 日志 ID |
| message_id | varchar(64) | 入站消息 ID |
| booth_number | varchar(64) null | 识别展位号 |
| issue_type_id | varchar(64) null | 识别问题类型 ID |
| issue_type_name | varchar(120) null | 问题类型快照 |
| confidence | decimal(5,4) | 置信度 |
| suggested_action | varchar(32) | create-ticket, urge-existing, needs-review, ignore |
| matched_ticket_id | varchar(64) null | 命中工单 |
| reason | text | 原因 |
| keyword_hits | json | 命中的关键词 |
| created_at | datetime | 创建时间 |

索引：

- `idx_analysis_message(message_id)`
- `idx_analysis_action(suggested_action)`
- `idx_analysis_booth(booth_number)`
- `idx_analysis_issue(issue_type_id)`

### wechat_order_logs

微信下工单链路日志。用于后台“微信下单日志”页面。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 日志 ID |
| message_id | varchar(64) null | 入站消息 ID |
| session_id | varchar(64) null | 追问会话 ID |
| ticket_id | varchar(64) null | 相关工单 |
| channel | varchar(16) | wechat, wecom |
| action | varchar(64) | received, ignored, prompted, registered, created-ticket, urged-existing, duplicate, failed |
| status | varchar(32) | success, pending, failed |
| summary | varchar(255) | 摘要 |
| detail | text null | 详情 |
| error_message | text null | 错误 |
| created_at | datetime | 创建时间 |

索引：

- `idx_order_logs_created(created_at)`
- `idx_order_logs_action(action)`
- `idx_order_logs_status(status)`
- `idx_order_logs_ticket(ticket_id)`
- `idx_order_logs_message(message_id)`

### pending_work_order_sessions

微信追问会话。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 会话 ID |
| platform | varchar(16) | wechat, wecom |
| conversation_id | varchar(64) | 会话 ID |
| chat_identity_id | varchar(64) | 微信身份 |
| original_message_record_id | varchar(64) null | 原始消息 |
| draft_text | text | 草稿文本 |
| draft_images | json | 草稿图片 |
| identity_group | varchar(120) null | 身份组 |
| contact_name | varchar(120) null | 联系人 |
| contact_phone | varchar(64) null | 手机号 |
| person_id | varchar(64) null | 绑定人员 |
| booth_number | varchar(64) null | 展位号 |
| issue_type_id | varchar(64) null | 问题类型 ID |
| issue_type_name | varchar(120) null | 问题类型快照 |
| missing_fields | json | 缺失字段 |
| status | varchar(32) | active, completed, expired, cancelled |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |
| last_prompt_at | datetime null | 最近追问时间 |

索引：

- `idx_pending_identity(chat_identity_id, status)`
- `idx_pending_updated(updated_at)`

### outbound_messages

出站通知。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 出站消息 ID |
| channel | varchar(16) | wechat, wecom |
| target_conversation_id | varchar(64) null | 目标会话 |
| target_chat_identity_id | varchar(64) null | 目标身份 |
| target_name | varchar(160) | 目标名称 |
| text | text | 消息内容 |
| related_ticket_id | varchar(64) null | 相关工单 |
| related_session_id | varchar(64) null | 相关追问 |
| status | varchar(32) | pending, sending, sent, failed |
| retry_count | int | 重试次数 |
| last_error | text null | 最近错误 |
| claimed_at | datetime null | 被发送进程领取时间 |
| sent_at | datetime null | 发送时间 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_outbound_status(status, created_at)`
- `idx_outbound_ticket(related_ticket_id)`
- `idx_outbound_session(related_session_id)`

### issue_types

问题类型设置。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 问题类型 ID |
| name | varchar(120) | 名称 |
| urgency_minutes | int | 催单分钟 |
| priority_weight | int | 优先级权重 |
| assignment_group_id | varchar(64) null | 默认处理组 |
| assignment_group_name_snapshot | varchar(120) null | 默认处理组快照 |
| enabled | boolean | 是否启用 |
| sort_order | int | 排序 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

约束与索引：

- `uniq_issue_type_name(name)`
- `idx_issue_enabled(enabled, sort_order)`

### assignment_rules

派单规则。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 规则 ID |
| booth_pattern | varchar(120) | 展位匹配规则 |
| issue_type_id | varchar(64) null | 问题类型 |
| handler_id | varchar(64) null | 处理人 |
| handler_name_snapshot | varchar(120) null | 处理人快照 |
| group_id | varchar(64) null | 处理组 |
| group_name_snapshot | varchar(120) null | 处理组快照 |
| priority | int | 规则优先级 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_assignment_issue(issue_type_id)`
- `idx_assignment_enabled(enabled, priority)`

### ticket_status_rules

状态流转规则。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 规则 ID |
| from_status | varchar(32) | 来源状态 |
| to_status | varchar(32) | 目标状态 |
| actor_group_id | varchar(64) null | 允许操作分组 |
| requires_reason | boolean | 是否需要原因 |
| enabled | boolean | 是否启用 |

索引：

- `idx_status_rules_from(from_status, enabled)`

### sla_rules

催单/SLA 规则。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 规则 ID |
| issue_type_id | varchar(64) null | 问题类型 |
| first_urge_minutes | int | 首次催单分钟 |
| escalation_minutes | int | 升级分钟 |
| max_urge_level | int | 最大催单级别 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_sla_issue(issue_type_id, enabled)`

### receipt_rules

微信回执规则。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 规则 ID |
| event_type | varchar(64) | created, urged, resolved, closed, rejected |
| channel | varchar(16) | wechat, wecom |
| enabled | boolean | 是否启用 |
| template | text | 回执模板 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_receipt_event(event_type, channel, enabled)`

### message_integrations

微信/企微接入配置。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 集成 ID |
| channel | varchar(16) | wechat, wecom |
| label | varchar(120) | 显示名称 |
| enabled | boolean | 是否启用 |
| mcp_server_name | varchar(160) | MCP 服务名 |
| endpoint | varchar(255) null | 接收地址 |
| secret_env | varchar(120) null | 密钥环境变量 |
| auto_create_tickets | boolean | 自动建单 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

约束：

- `uniq_message_integrations_channel(channel)`

### ai_model_configs

AI 接口配置。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | fast, smart |
| label | varchar(120) | 显示名称 |
| provider | varchar(32) | mock, http |
| endpoint | varchar(255) null | 接口地址 |
| api_key_env | varchar(120) null | 密钥环境变量 |
| model_name | varchar(160) | 模型名 |
| timeout_ms | int | 超时毫秒 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### keyword_groups

关键词分组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 分组 ID |
| name | varchar(120) | 分组名称 |
| type | varchar(32) | operational, issue-type, ignore, identity |
| description | varchar(255) null | 说明 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_keyword_groups_type(type, enabled)`

### keyword_rules

关键词规则。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 规则 ID |
| group_id | varchar(64) | 关键词分组 |
| keyword | varchar(120) | 关键词 |
| match_type | varchar(32) | contains, exact, regex |
| issue_type_id | varchar(64) null | 映射问题类型 |
| weight | int | 权重 |
| enabled | boolean | 是否启用 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

索引：

- `idx_keyword_group(group_id, enabled)`
- `idx_keyword_issue(issue_type_id)`
- `idx_keyword_value(keyword)`

预设来源：

- 工单触发关键词：报修、故障、处理、需要、不能、无法、没有、坏、断、催、加急、尽快、失败、漏水、跳闸。
- 网络关键词：网络、断网、网线、wifi、wi-fi、扫码、收款。
- 电力关键词：电力、没电、断电、电源、接电、用电、电箱、插座、跳闸、照明、不亮、灯。
- 搭建关键词：搭建、门头、背板、地毯、展板、结构、施工。
- 综合服务关键词：电联、电话、联系、联系不上、联络、打不通、不通、桌、椅、物料、租赁、会刊、证件、服务。

### app_config_versions

配置版本。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 版本 ID |
| version | int | 版本号 |
| snapshot | json | 配置快照 |
| changed_by | varchar(64) null | 操作人 |
| change_summary | varchar(255) | 变更摘要 |
| created_at | datetime | 创建时间 |

索引：

- `idx_config_versions_created(created_at)`
- `uniq_config_version(version)`

### audit_logs

后台操作审计。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 日志 ID |
| actor_id | varchar(64) null | 操作人 |
| actor_name | varchar(120) null | 操作人名称 |
| action | varchar(120) | 操作 |
| entity_type | varchar(80) | 对象类型 |
| entity_id | varchar(64) null | 对象 ID |
| before_snapshot | json null | 修改前 |
| after_snapshot | json null | 修改后 |
| ip_address | varchar(80) null | IP |
| user_agent | varchar(255) null | UA |
| created_at | datetime | 创建时间 |

索引：

- `idx_audit_created(created_at)`
- `idx_audit_entity(entity_type, entity_id)`
- `idx_audit_action(action)`

### import_jobs

展览数据导入任务。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 导入任务 ID |
| exhibition_id | varchar(64) | 展会 ID |
| file_name | varchar(255) | 文件名 |
| status | varchar(32) | pending, validating, imported, failed |
| total_rows | int | 总行数 |
| success_rows | int | 成功行数 |
| failed_rows | int | 失败行数 |
| error_summary | text null | 错误摘要 |
| created_by | varchar(64) null | 操作人 |
| created_at | datetime | 创建时间 |
| completed_at | datetime null | 完成时间 |

索引：

- `idx_import_jobs_created(created_at)`
- `idx_import_jobs_status(status)`

### import_job_rows

导入任务明细行。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(64) pk | 行 ID |
| job_id | varchar(64) | 导入任务 |
| row_number | int | 行号 |
| status | varchar(32) | valid, imported, failed |
| raw_payload | json | 原始行 |
| normalized_payload | json null | 标准化行 |
| error_message | text null | 错误 |

索引：

- `idx_import_rows_job(job_id, row_number)`
- `idx_import_rows_status(job_id, status)`

## 事务边界

### 微信消息进入系统

一次入站消息处理应在一个事务内完成：

1. 写入 `inbound_messages`。
2. 创建或更新 `chat_identities` 和 `conversations`。
3. 写入 `message_analysis_logs`。
4. 根据结果写入 `wechat_order_logs`。
5. 如果需要追问，写入或更新 `pending_work_order_sessions`，并写入 `outbound_messages`。
6. 如果自动建单，写入 `tickets`、`ticket_feedback_users`、`ticket_timeline`，并写入 `outbound_messages`。

如果事务失败，返回明确错误，写入失败日志。失败日志可以在事务外追加，避免主事务回滚后完全丢失排查线索。

### 配置保存

一次后台配置保存应在一个事务内完成：

1. 更新对应配置表。
2. 生成 `app_config_versions`。
3. 写入 `audit_logs`。

### 展览数据导入

导入分为两步：

1. 校验阶段：创建 `import_jobs` 和 `import_job_rows`，不影响正式展位数据。
2. 导入阶段：按校验结果 upsert `exhibition_booths`，更新导入任务状态，写审计日志。

## Repository 设计

第一阶段建议定义接口，再提供 MariaDB 实现。

```ts
type TicketRepository = {
  listTickets(filter: TicketFilter): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | null>;
  createTicket(input: CreateTicketInput): Promise<Ticket>;
  updateTicketStatus(input: UpdateTicketStatusInput): Promise<Ticket>;
  addReply(input: AddReplyInput): Promise<TicketReply>;
};

type MessageRepository = {
  recordInboundMessage(input: RecordInboundMessageInput): Promise<InboundMessageRecord>;
  recordAnalysis(input: RecordMessageAnalysisInput): Promise<void>;
  appendWechatOrderLog(input: AppendWechatOrderLogInput): Promise<void>;
  listWechatOrderLogs(filter: WechatOrderLogFilter): Promise<WechatOrderLogPage>;
};

type ConfigRepository = {
  getRuntimeConfig(): Promise<AppConfig>;
  updateConfigPatch(input: UpdateConfigPatchInput): Promise<AppConfig>;
  createConfigVersion(input: CreateConfigVersionInput): Promise<void>;
};

type ExhibitionRepository = {
  listBooths(filter: BoothFilter): Promise<BoothRecord[]>;
  upsertBooths(input: UpsertBoothsInput): Promise<void>;
  createImportJob(input: CreateImportJobInput): Promise<ImportJob>;
};
```

现有服务逐步从 `readState()` / `writeState()` 改为 Repository。迁移期间可以保留一个 `FileStoreRepository` 用于测试和回退。

## 迁移策略

### 阶段 1：建库与迁移脚本

- 新增数据库连接配置。
- 新增 schema 初始化脚本。
- 新增从 `data/app-state.json` 迁移到 MariaDB 的脚本。
- 保留 JSON 文件，不立即删除。

### 阶段 2：读写双轨

- 新增 Repository 接口。
- 先让后台和核心服务读取数据库。
- 必要时保留 JSON fallback，仅用于开发环境。

### 阶段 3：核心业务切换

- 工单 API 切换到数据库。
- 微信入站、追问、出站通知切换到数据库。
- 配置保存切换到数据库并写审计。

### 阶段 4：后台新模块

- 微信下单日志页面从 `wechat_order_logs` 查询。
- 集成配置页面写入数据库配置表。
- 关键词配置页面写入 `keyword_groups` / `keyword_rules`。
- 展览数据页面先展示入口和空状态，上传解析功能下一阶段实现。
- 工单设置页面接入问题类型、派单规则、状态流转、SLA、回执规则。

### 阶段 5：停用 JSON 主存储

- 所有运行时读写都通过 MariaDB。
- JSON 文件只保留为开发示例或导出备份。

## 后台页面与数据模型映射

```text
工作台
  tickets
  inbound_messages
  wechat_order_logs
  outbound_messages
  pending_work_order_sessions

微信下单
  inbound_messages
  message_analysis_logs
  wechat_order_logs
  pending_work_order_sessions
  outbound_messages

工单设置
  issue_types
  assignment_rules
  ticket_status_rules
  sla_rules
  receipt_rules

集成配置
  message_integrations
  ai_model_configs
  keyword_groups
  keyword_rules

展览数据
  exhibitions
  exhibition_booths
  import_jobs
  import_job_rows

组织权限
  user_groups
  people
  chat_identities
  conversations
  conversation_people

系统日志
  audit_logs
  app_config_versions
  wechat_order_logs
```

## 查询需求与索引

微信下单日志页需要支持：

- 按时间范围筛选：`wechat_order_logs.created_at`
- 按动作筛选：`wechat_order_logs.action`
- 按状态筛选：`wechat_order_logs.status`
- 按工单筛选：`wechat_order_logs.ticket_id`
- 按展位号筛选：通过 `message_analysis_logs.booth_number`
- 按问题类型筛选：通过 `message_analysis_logs.issue_type_id`
- 按发送人筛选：`inbound_messages.sender_name` 或 `sender_id`

工单页需要支持：

- 状态、处理组、处理人、问题类型、展位号、创建时间。

展览数据页需要支持：

- 展位号、公司名称、业务员、搭建商、启用状态。

## 配置文件定位

配置文件不再作为运行时真相源。它改为：

- 默认 seed。
- 本地开发示例。
- 数据库初始化来源。
- 关键词预设来源。
- 紧急恢复时的导出参考。

后台保存的配置以数据库为准。

## 部署建议

Windows 本地部署建议：

```text
MariaDB 11.4
  数据库名: collaboration_board
  用户: collaboration_board_app
  字符集: utf8mb4

Next.js App
  DATABASE_URL=mysql://collaboration_board_app:***@127.0.0.1:3306/collaboration_board
```

字符集必须使用 `utf8mb4`，避免中文、emoji 和微信昵称写入异常。

## 风险与对策

### 数据迁移风险

风险：现有 JSON 中存在历史字段缺失或中文编码异常。

对策：迁移脚本采用宽松解析，缺失字段写默认值；迁移报告列出异常记录，不直接丢弃。

### 并发写入风险

风险：微信入站和后台操作同时写同一工单。

对策：数据库事务处理；关键状态变更使用条件更新，例如只允许从当前状态转到目标状态。

### 配置兼容风险

风险：现有代码仍依赖 `AppConfig` 结构。

对策：`ConfigRepository.getRuntimeConfig()` 继续返回 `AppConfig` 兼容结构，内部从多张配置表组装。

### 日志增长风险

风险：微信日志持续增长影响查询。

对策：第一阶段按 `created_at` 建索引；后续可按月份归档 `wechat_order_logs` 和 `inbound_messages`。

## 第一阶段实施建议

第一阶段只做数据库基础，不急着重写所有后台页面：

1. 建 MariaDB schema。
2. 写 JSON 到数据库迁移脚本。
3. 建 Repository 接口和 MariaDB adapter。
4. 先迁移配置、工单、微信消息、微信下单日志。
5. 后台重构时直接面向数据库模型搭页面。

这样避免继续围绕 JSON 结构搭后台，减少返工。
