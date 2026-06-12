"use client";

import { useState } from "react";
import { Check, Download, FileSpreadsheet, Upload, X } from "lucide-react";
import * as XLSX from "xlsx";
import {
  USER_IMPORT_COLUMNS,
  type UserImportAction,
  type UserImportDecision,
  type UserImportJob
} from "@/lib/domain/user-import";

const ERROR_LABELS: Record<string, string> = {
  "missing-name": "姓名为空",
  "invalid-phone": "手机号格式错误",
  "unknown-group": "分组不存在",
  "group-disabled": "分组已停用",
  "invalid-group-locked": "分组锁定值无效",
  "invalid-enabled": "启用状态值无效",
  "file-phone-duplicate": "文件内手机号重复",
  "file-wechat-duplicate": "文件内微信标识重复",
  "file-wecom-duplicate": "文件内企微标识重复"
};

const CONFLICT_LABELS: Record<string, string> = {
  "phone-exists": "手机号已存在",
  "wechat-occupied": "微信已绑定其他用户",
  "wecom-occupied": "企微已绑定其他用户",
  "stale-preview": "预览后数据已变化"
};

function messageOf(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function defaultDecision(job: UserImportJob) {
  return Object.fromEntries(job.rows.map((row) => {
    const action: UserImportAction = row.errors.length > 0
      ? "skip"
      : row.allowedActions.includes("overwrite")
        ? "overwrite"
        : "add";
    return [row.id, {
      action,
      confirmWechatRebind: false,
      confirmWecomRebind: false
    } satisfies UserImportDecision];
  }));
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function downloadBytes(bytes: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AdminUserImport({
  onClose,
  onCompleted
}: {
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<UserImportJob | null>(null);
  const [decisions, setDecisions] = useState<Record<string, UserImportDecision>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...USER_IMPORT_COLUMNS],
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

  async function preview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await file.arrayBuffer();
      const workbook = XLSX.read(bytes, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) throw new Error("文件中没有可读取的工作表");
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "" });
      const response = await fetch("/api/admin/user-imports/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: file.name,
          sourceHash: await sha256(bytes),
          rows
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageOf(payload, "用户导入预览失败"));
      const nextJob = payload as UserImportJob;
      setJob(nextJob);
      setDecisions(defaultDecision(nextJob));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "用户导入预览失败");
    } finally {
      setBusy(false);
    }
  }

  function updateDecision(rowId: string, patch: Partial<UserImportDecision>) {
    setDecisions((current) => ({
      ...current,
      [rowId]: { ...current[rowId], ...patch }
    }));
  }

  function applyBulk(action: UserImportAction) {
    if (!job) return;
    setDecisions((current) => Object.fromEntries(job.rows.map((row) => {
      const nextAction = row.allowedActions.includes(action) ? action : "skip";
      return [row.id, {
        ...(current[row.id] ?? {
          action: nextAction,
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }),
        action: nextAction,
        ...(nextAction === "skip" ? {
          confirmWechatRebind: false,
          confirmWecomRebind: false
        } : {})
      }];
    })));
  }

  async function commit() {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const rows = job.rows.map((row) => ({
        rowId: row.id,
        decision: decisions[row.id]
      }));
      const decisionResponse = await fetch(`/api/admin/user-imports/${job.id}/rows`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows })
      });
      const decisionPayload = await decisionResponse.json().catch(() => null);
      if (!decisionResponse.ok) {
        throw new Error(messageOf(decisionPayload, "导入决策保存失败"));
      }
      const commitResponse = await fetch(`/api/admin/user-imports/${job.id}/commit`, {
        method: "POST"
      });
      const commitPayload = await commitResponse.json().catch(() => null);
      if (!commitResponse.ok) {
        if (commitResponse.status === 409) {
          const refreshResponse = await fetch(`/api/admin/user-imports/${job.id}`, { cache: "no-store" });
          if (refreshResponse.ok) setJob(await refreshResponse.json() as UserImportJob);
        }
        throw new Error(messageOf(commitPayload, "用户批量导入失败"));
      }
      setJob(commitPayload as UserImportJob);
      onCompleted();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "用户批量导入失败");
    } finally {
      setBusy(false);
    }
  }

  const step = !job ? 1 : job.status === "completed" ? 3 : 2;

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
                  <span>{USER_IMPORT_COLUMNS.join("、")}</span>
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
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <button className="primary-button" type="button" onClick={() => void preview()} disabled={!file || busy}>
                {busy ? "解析中..." : "生成预览"}
              </button>
            </div>
          )}

          {step === 2 && job && (
            <div className="admin-import-preview">
              <div className="admin-import-summary">
                <span>共 {job.rows.length} 行</span>
                <span>{job.rows.filter((row) => row.errors.length > 0).length} 行不可导入</span>
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
                {job.rows.map((row) => {
                  const decision = decisions[row.id];
                  return (
                    <article className="admin-import-row" key={row.id}>
                      <span>{row.rowNumber}</span>
                      <div><strong>{row.normalized.name || "未填写"}</strong><small>{row.normalized.phone || "手机号无效"}</small></div>
                      <span>{row.normalized.groupId || "未识别"}</span>
                      <div className="admin-import-identities">
                        <small>微信：{row.normalized.wechatExternalUserId ?? "-"}</small>
                        <small>企微：{row.normalized.wecomExternalUserId ?? "-"}</small>
                      </div>
                      <div className="admin-import-issues">
                        {row.errors.map((code) => <em className="error" key={code}>{ERROR_LABELS[code] ?? code}</em>)}
                        {row.conflicts.map((code) => <em key={code}>{CONFLICT_LABELS[code] ?? code}</em>)}
                        {row.errors.length === 0 && row.conflicts.length === 0 && <em className="success">可导入</em>}
                      </div>
                      <div className="admin-import-decision">
                        <select
                          aria-label={`第${row.rowNumber}行操作`}
                          value={decision?.action ?? "skip"}
                          onChange={(event) => updateDecision(row.id, {
                            action: event.target.value as UserImportAction,
                            ...(event.target.value === "skip" ? {
                              confirmWechatRebind: false,
                              confirmWecomRebind: false
                            } : {})
                          })}
                        >
                          {row.allowedActions.map((action) => (
                            <option key={action} value={action}>
                              {action === "add" ? "新增" : action === "overwrite" ? "覆盖" : "跳过"}
                            </option>
                          ))}
                        </select>
                        {row.conflicts.includes("wechat-occupied") && decision?.action !== "skip" && (
                          <label>
                            <input
                              type="checkbox"
                              checked={decision?.confirmWechatRebind ?? false}
                              onChange={(event) => updateDecision(row.id, { confirmWechatRebind: event.target.checked })}
                            />
                            确认微信换绑
                          </label>
                        )}
                        {row.conflicts.includes("wecom-occupied") && decision?.action !== "skip" && (
                          <label>
                            <input
                              type="checkbox"
                              checked={decision?.confirmWecomRebind ?? false}
                              onChange={(event) => updateDecision(row.id, { confirmWecomRebind: event.target.checked })}
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
                <button className="secondary-button" type="button" onClick={() => { setJob(null); setError(null); }}>重新选文件</button>
                <button className="primary-button" type="button" onClick={() => void commit()} disabled={busy}>
                  {busy ? "提交中..." : "提交导入"}
                </button>
              </div>
            </div>
          )}

          {step === 3 && job && (
            <div className="admin-import-result">
              <Check size={28} aria-hidden="true" />
              <h3>用户导入完成</h3>
              <div>
                <span>新增 {job.rows.filter((row) => row.resultAction === "add").length}</span>
                <span>覆盖 {job.rows.filter((row) => row.resultAction === "overwrite").length}</span>
                <span>跳过 {job.rows.filter((row) => row.resultAction === "skip").length}</span>
              </div>
              <a className="secondary-button" href={`/api/admin/user-imports/${job.id}/report`} download>
                <Download size={16} aria-hidden="true" />
                下载导入报告
              </a>
              <button className="primary-button" type="button" onClick={onClose}>完成</button>
            </div>
          )}

          {error && <p className="admin-import-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
