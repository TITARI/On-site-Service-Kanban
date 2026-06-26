"use client";

import { useState } from "react";
import { Check, Download, FileSpreadsheet, Upload, X } from "lucide-react";
import * as XLSX from "xlsx";
import {
  USER_IMPORT_TEMPLATE_COLUMNS,
  type UserImportAction,
  type UserImportDecision,
  type UserImportPreview,
  type UserImportPreviewRow
} from "@/lib/domain/user-import";

type Props = {
  onClose: () => void;
  onCompleted: () => void | Promise<void>;
};

type CompletedImport = {
  committed: number;
  add: number;
  overwrite: number;
  skip: number;
  blocked: number;
};

const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;

const ACTION_LABELS: Record<UserImportAction, string> = {
  add: "新增",
  overwrite: "覆盖",
  skip: "跳过"
};

const CATEGORY_LABELS: Record<UserImportPreviewRow["category"], string> = {
  add: "新增",
  overwrite: "覆盖",
  blocked: "阻塞"
};

const ERROR_LABELS: Record<string, string> = {
  "missing-name": "姓名为空",
  "invalid-phone": "手机号格式错误",
  "missing-group": "分组为空",
  "unknown-group": "分组不存在",
  "disabled-group": "分组已停用",
  "invalid-group-locked": "分组锁定值无效",
  "invalid-enabled": "启用状态值无效",
  "file-phone-duplicate": "文件内手机号重复",
  "wechat-file-duplicate": "文件内微信标识重复",
  "wecom-file-duplicate": "文件内企微标识重复"
};

const CONFLICT_LABELS: Record<string, string> = {
  "phone-occupied": "手机号已存在",
  "wechat-occupied": "微信已绑定其他用户",
  "wecom-occupied": "企微已绑定其他用户",
  "stale-preview": "预览后数据已变化"
};

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { message?: string };
    return payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function parseRows(bytes: ArrayBuffer) {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("导入文件没有可读取的工作表");
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[sheetName],
    { defval: "" }
  );
}

function downloadBytes(bytes: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function defaultDecision(row: UserImportPreviewRow): UserImportDecision {
  const action = row.allowedActions.find((item) => item !== "skip") ?? "skip";
  if (action === "skip") {
    return {
      action,
      confirmWechatRebind: false,
      confirmWecomRebind: false
    };
  }
  return {
    action,
    confirmWechatRebind: false,
    confirmWecomRebind: false
  };
}

function selectedDecision(row: UserImportPreviewRow, decisions: Record<string, UserImportDecision>) {
  return decisions[row.id] ?? row.decision ?? defaultDecision(row);
}

function rawValue(row: UserImportPreviewRow, columnIndex: number) {
  const column = USER_IMPORT_TEMPLATE_COLUMNS[columnIndex];
  return String(row.raw[column] ?? "").trim();
}

function issueLabel(code: string) {
  return ERROR_LABELS[code] ?? CONFLICT_LABELS[code] ?? code;
}

export function AdminUserImport({ onClose, onCompleted }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UserImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, UserImportDecision>>({});
  const [completed, setCompleted] = useState<CompletedImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = !preview ? 1 : completed ? 3 : 2;

  function reset() {
    setFile(null);
    setPreview(null);
    setDecisions({});
    setCompleted(null);
    setError(null);
  }

  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...USER_IMPORT_TEMPLATE_COLUMNS],
      ["张三", "13800138000", "搭建组", "是", "启用", "wxid-zhang", "wecom-zhang"]
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "用户导入模板");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    downloadBytes(
      bytes,
      "用户批量导入模板.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  }

  async function previewFile() {
    if (!file) return;
    if (file.size > MAX_PREVIEW_SIZE) {
      setError(`文件超过 ${MAX_PREVIEW_SIZE / 1024 / 1024}MB 限制`);
      return;
    }
    setBusy(true);
    setError(null);
    setCompleted(null);
    try {
      const bytes = await file.arrayBuffer();
      const response = await fetch("/api/admin/user-imports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: file.name,
          sourceHash: await sha256(bytes),
          rows: parseRows(bytes)
        })
      });
      if (!response.ok) throw new Error(await responseMessage(response, "用户导入预览失败"));
      const nextPreview = await response.json() as UserImportPreview;
      setPreview(nextPreview);
      setDecisions(Object.fromEntries(
        nextPreview.rows.map((row) => [row.id, defaultDecision(row)])
      ));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "用户导入预览失败");
    } finally {
      setBusy(false);
    }
  }

  function updateDecision(rowId: string, patch: Partial<UserImportDecision>) {
    setDecisions((current) => {
      const row = preview?.rows.find((item) => item.id === rowId);
      if (!row) return current;
      const next = {
        ...selectedDecision(row, current),
        ...patch
      } as UserImportDecision;
      if (next.action === "skip") {
        next.confirmWechatRebind = false;
        next.confirmWecomRebind = false;
      }
      return { ...current, [rowId]: next };
    });
  }

  function applyBulk(action: UserImportAction) {
    if (!preview) return;
    setDecisions((current) => Object.fromEntries(preview.rows.map((row) => {
      const nextAction = row.selectable && row.allowedActions.includes(action) ? action : "skip";
      const currentDecision = selectedDecision(row, current);
      return [row.id, {
        ...currentDecision,
        action: nextAction,
        confirmWechatRebind: nextAction === "skip" ? false : currentDecision.confirmWechatRebind,
        confirmWecomRebind: nextAction === "skip" ? false : currentDecision.confirmWecomRebind
      } as UserImportDecision];
    })));
    setError(null);
  }

  function validateDecisions() {
    if (!preview) return false;
    for (const row of preview.rows) {
      if (!row.selectable) continue;
      const decision = selectedDecision(row, decisions);
      if (
        decision.action !== "skip" &&
        row.conflicts.includes("wechat-occupied") &&
        !decision.confirmWechatRebind
      ) {
        setError(`第 ${row.rowNumber} 行需要确认换绑微信身份`);
        return false;
      }
      if (
        decision.action !== "skip" &&
        row.conflicts.includes("wecom-occupied") &&
        !decision.confirmWecomRebind
      ) {
        setError(`第 ${row.rowNumber} 行需要确认换绑企业微信身份`);
        return false;
      }
    }
    setError(null);
    return true;
  }

  async function saveDecisions() {
    if (!preview || !validateDecisions()) return false;
    const response = await fetch(`/api/admin/user-imports/${preview.jobId}/rows`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decisions: preview.rows
          .filter((row) => row.selectable)
          .map((row) => ({
            rowId: row.id,
            decision: selectedDecision(row, decisions)
          }))
      })
    });
    if (!response.ok) throw new Error(await responseMessage(response, "导入决策保存失败"));
    return true;
  }

  async function commitImport() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await saveDecisions();
      const response = await fetch(`/api/admin/user-imports/${preview.jobId}/commit`, {
        method: "POST"
      });
      if (!response.ok) {
        const message = await responseMessage(response, "用户批量导入失败");
        if (response.status === 409) {
          const refreshResponse = await fetch(`/api/admin/user-imports/${preview.jobId}`, { cache: "no-store" });
          if (refreshResponse.ok) {
            const refreshedPreview = await refreshResponse.json() as UserImportPreview;
            setPreview(refreshedPreview);
          }
        }
        throw new Error(message);
      }
      const payload = await response.json() as { committed?: number };
      const selected = preview.rows.map((row) => selectedDecision(row, decisions));
      setCompleted({
        committed: payload.committed ?? 0,
        add: selected.filter((decision) => decision.action === "add").length,
        overwrite: selected.filter((decision) => decision.action === "overwrite").length,
        skip: selected.filter((decision) => decision.action === "skip").length,
        blocked: preview.summary.blocked
      });
      await onCompleted();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "用户批量导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function downloadReport() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/user-imports/${preview.jobId}/report`);
      if (!response.ok) throw new Error(await responseMessage(response, "下载导入报告失败"));
      downloadBytes(
        await response.blob(),
        `user-import-${preview.jobId}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "下载导入报告失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-import-layer">
      <button className="admin-import-scrim" type="button" aria-label="关闭批量导入" onClick={onClose} />
      <section className="admin-import-panel" role="dialog" aria-modal="true" aria-labelledby="admin-import-title">
        <header>
          <div>
            <p className="eyebrow">用户与权限</p>
            <h2 id="admin-import-title">批量导入用户</h2>
          </div>
          <button className="admin-icon-button" type="button" onClick={onClose} aria-label="关闭导入向导" title="关闭">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <ol className="admin-import-steps" aria-label="导入进度">
          {["选择文件", "处理冲突", "导入结果"].map((label, index) => (
            <li key={label} className={step >= index + 1 ? "active" : undefined}>
              <span>{step > index + 1 ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <div className="admin-import-body">
          {step === 1 && (
            <div className="admin-import-upload">
              <div className="admin-import-template">
                <FileSpreadsheet size={24} aria-hidden="true" />
                <div>
                  <strong>用户导入模板</strong>
                  <span>{USER_IMPORT_TEMPLATE_COLUMNS.join("、")}</span>
                </div>
                <button className="secondary-button" type="button" onClick={downloadTemplate}>
                  <Download size={16} aria-hidden="true" />
                  下载模板
                </button>
              </div>
              <label className="admin-import-file">
                <Upload size={22} aria-hidden="true" />
                <span>{file?.name ?? "选择 Excel 或 CSV 文件"}</span>
                <input
                  aria-label="选择用户导入文件"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  disabled={busy}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setError(null);
                  }}
                />
              </label>
              <button className="primary-button" type="button" onClick={() => void previewFile()} disabled={!file || busy}>
                {busy ? "解析中..." : "生成预览"}
              </button>
            </div>
          )}

          {step === 2 && preview && (
            <div className="admin-import-preview">
              <div className="admin-import-summary">
                <span>共 {preview.rows.length} 行</span>
                <span>{preview.summary.blocked} 行不可导入</span>
                <div>
                  <button type="button" onClick={() => applyBulk("add")}>可新增项设为新增</button>
                  <button type="button" onClick={() => applyBulk("overwrite")}>可覆盖项设为覆盖</button>
                  <button type="button" onClick={() => applyBulk("skip")}>全部跳过</button>
                </div>
              </div>
              <div className="admin-import-table">
                <div className="admin-import-row admin-import-head">
                  <span>行</span>
                  <span>用户</span>
                  <span>分组</span>
                  <span>账号标识</span>
                  <span>校验结果</span>
                  <span>操作</span>
                </div>
                {preview.rows.map((row) => {
                  const decision = selectedDecision(row, decisions);
                  const displayName = row.value?.name || rawValue(row, 0) || "未填写";
                  const displayPhone = row.value?.phone || rawValue(row, 1) || "手机号无效";
                  const displayGroup = row.value?.groupId || rawValue(row, 2) || "未识别";
                  return (
                    <article className="admin-import-row" key={row.id}>
                      <span>{row.rowNumber}</span>
                      <div>
                        <strong>{displayName}</strong>
                        <small>{displayPhone}</small>
                      </div>
                      <span>{displayGroup}</span>
                      <div className="admin-import-identities">
                        <small>微信：{(row.value?.wechatExternalUserId ?? rawValue(row, 5)) || "-"}</small>
                        <small>企微：{(row.value?.wecomExternalUserId ?? rawValue(row, 6)) || "-"}</small>
                      </div>
                      <div className="admin-import-issues">
                        {row.conflicts.map((code) => (
                          <em className={ERROR_LABELS[code] ? "error" : undefined} key={code}>
                            {issueLabel(code)}
                          </em>
                        ))}
                        {row.conflicts.length === 0 && <em className="success">可导入</em>}
                      </div>
                      <div className="admin-import-decision">
                        <select
                          aria-label={`第 ${row.rowNumber} 行操作`}
                          value={decision.action}
                          disabled={!row.selectable || busy}
                          onChange={(event) => updateDecision(row.id, {
                            action: event.target.value as UserImportAction
                          })}
                        >
                          {row.allowedActions.map((action) => (
                            <option key={action} value={action}>{ACTION_LABELS[action]}</option>
                          ))}
                        </select>
                        {row.conflicts.includes("wechat-occupied") && decision.action !== "skip" && (
                          <label>
                            <input
                              type="checkbox"
                              aria-label="确认微信换绑"
                              checked={decision.confirmWechatRebind}
                              disabled={busy}
                              onChange={(event) => updateDecision(row.id, {
                                confirmWechatRebind: event.target.checked
                              })}
                            />
                            确认微信换绑
                          </label>
                        )}
                        {row.conflicts.includes("wecom-occupied") && decision.action !== "skip" && (
                          <label>
                            <input
                              type="checkbox"
                              aria-label="确认企微换绑"
                              checked={decision.confirmWecomRebind}
                              disabled={busy}
                              onChange={(event) => updateDecision(row.id, {
                                confirmWecomRebind: event.target.checked
                              })}
                            />
                            确认企微换绑
                          </label>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="admin-import-actions">
                <button className="secondary-button" type="button" onClick={reset}>重新选文件</button>
                <button className="primary-button" type="button" onClick={() => void commitImport()} disabled={busy}>
                  {busy ? "提交中..." : "提交导入"}
                </button>
              </div>
            </div>
          )}

          {step === 3 && completed && (
            <div className="admin-import-result">
              <Check size={28} aria-hidden="true" />
              <h3>用户导入完成</h3>
              <p>已提交 {completed.committed} 行，导入报告可用于复核每行结果。</p>
              <div>
                <span>新增 {completed.add}</span>
                <span>覆盖 {completed.overwrite}</span>
                <span>跳过 {completed.skip}</span>
                <span>阻塞 {completed.blocked}</span>
              </div>
              <button className="secondary-button" type="button" onClick={() => void downloadReport()} disabled={busy}>
                <Download size={16} aria-hidden="true" />
                {busy ? "下载中..." : "下载导入报告"}
              </button>
              <button className="primary-button" type="button" onClick={onClose}>完成</button>
            </div>
          )}

          {error && <p className="admin-import-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
