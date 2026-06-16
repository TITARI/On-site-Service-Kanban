"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import type {
  UserImportAction,
  UserImportDecision,
  UserImportPreview,
  UserImportPreviewRow
} from "@/lib/domain/user-import";

type Props = {
  onCommitted?: () => void | Promise<void>;
};

type BusyState = "parse" | "save" | "commit" | "report" | null;

const ACTION_LABELS: Record<UserImportAction, string> = {
  add: "新增",
  overwrite: "覆盖",
  skip: "跳过"
};

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { message?: string };
    return payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function sha256(file: File) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

async function parseRows(file: File) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("导入文件没有可读取的工作表");
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[sheetName],
    { defval: "" }
  );
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

export function AdminUserImport({ onCommitted }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UserImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, UserImportDecision>>({});
  const [busy, setBusy] = useState<BusyState>(null);
  const [fileError, setFileError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [commitError, setCommitError] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [bulkAction, setBulkAction] = useState<UserImportAction>("skip");

  const categories = useMemo(() => {
    const rows = preview?.rows ?? [];
    return {
      add: rows.filter((row) => row.category === "add").length,
      overwrite: rows.filter((row) => row.category === "overwrite").length,
      blocked: rows.filter((row) => row.category === "blocked").length
    };
  }, [preview]);

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

  function applyBulkDecision() {
    if (!preview) return;
    setDecisions((current) => {
      const next = { ...current };
      for (const row of preview.rows) {
        if (!row.selectable || !row.allowedActions.includes(bulkAction)) {
          continue;
        }
        const currentDecision = selectedDecision(row, current);
        next[row.id] = {
          ...currentDecision,
          action: bulkAction,
          confirmWechatRebind: bulkAction === "skip"
            ? false
            : currentDecision.confirmWechatRebind,
          confirmWecomRebind: bulkAction === "skip"
            ? false
            : currentDecision.confirmWecomRebind
        } as UserImportDecision;
      }
      return next;
    });
    setDecisionError("");
  }

  async function previewFile() {
    if (!file) {
      setFileError("请选择 .xlsx、.xls 或 .csv 文件");
      return;
    }
    setBusy("parse");
    setFileError("");
    setDecisionError("");
    setCommitError("");
    setCommitMessage("");
    try {
      const [rows, sourceHash] = await Promise.all([
        parseRows(file),
        sha256(file)
      ]);
      const response = await fetch("/api/admin/user-imports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: file.name,
          sourceHash,
          rows
        })
      });
      if (!response.ok) throw new Error(await responseMessage(response, "预览导入失败"));
      const payload = await response.json() as UserImportPreview;
      setPreview(payload);
      setDecisions(Object.fromEntries(
        payload.rows
          .filter((row) => row.selectable)
          .map((row) => [row.id, defaultDecision(row)])
      ));
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "预览导入失败");
    } finally {
      setBusy(null);
    }
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
        setDecisionError(`第 ${row.rowNumber} 行需要确认换绑 WeChat 身份`);
        return false;
      }
      if (
        decision.action !== "skip" &&
        row.conflicts.includes("wecom-occupied") &&
        !decision.confirmWecomRebind
      ) {
        setDecisionError(`第 ${row.rowNumber} 行需要确认换绑 WeCom 身份`);
        return false;
      }
    }
    setDecisionError("");
    return true;
  }

  async function saveDecisions() {
    if (!preview || !validateDecisions()) return false;
    setBusy("save");
    try {
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
      if (!response.ok) throw new Error(await responseMessage(response, "保存冲突处理失败"));
      return true;
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "保存冲突处理失败");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function commitImport() {
    if (!preview) return;
    setCommitError("");
    setCommitMessage("");
    const saved = await saveDecisions();
    if (!saved) return;
    setBusy("commit");
    try {
      const response = await fetch(`/api/admin/user-imports/${preview.jobId}/commit`, {
        method: "POST"
      });
      if (!response.ok) throw new Error(await responseMessage(response, "提交导入失败"));
      const payload = await response.json() as { committed?: number };
      setCommitMessage(`已提交 ${payload.committed ?? 0} 行`);
      await onCommitted?.();
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : "提交导入失败");
    } finally {
      setBusy(null);
    }
  }

  async function downloadReport() {
    if (!preview) return;
    setBusy("report");
    setCommitError("");
    try {
      const response = await fetch(`/api/admin/user-imports/${preview.jobId}/report`);
      if (!response.ok) throw new Error(await responseMessage(response, "下载导入报告失败"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `user-import-${preview.jobId}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : "下载导入报告失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="admin-user-import" aria-label="用户导入">
      <div className="admin-import-head">
        <div>
          <h4>用户导入</h4>
          <p>按三步完成批量预览、冲突处理、提交与报告下载。</p>
        </div>
      </div>

      <ol className="admin-import-steps" aria-label="导入步骤">
        <li className={preview ? "done" : "active"}>1. 选择文件</li>
        <li className={preview ? "active" : ""}>2. 处理冲突</li>
        <li className={commitMessage ? "done" : ""}>3. 提交并下载报告</li>
      </ol>

      <div className="admin-import-file-row">
        <label>
          <span>导入文件</span>
          <input
            aria-label="导入文件"
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={busy !== null}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setFileError("");
            }}
          />
        </label>
        <button className="primary-button" type="button" onClick={() => void previewFile()} disabled={!file || busy !== null}>
          {busy === "parse" ? "解析中..." : "解析并预览"}
        </button>
      </div>
      {fileError && <p className="form-message" role="alert">{fileError}</p>}

      {preview && (
        <div className="admin-import-preview">
          <div className="admin-import-summary" aria-live="polite">
            需处理 {preview.summary.total} 行，可导入 {preview.summary.selectable} 行，阻塞 {preview.summary.blocked} 行
          </div>
          <div className="admin-import-category-grid">
            <span>新增 {categories.add}</span>
            <span>覆盖 {categories.overwrite}</span>
            <span>阻塞 {categories.blocked}</span>
          </div>
          <div className="admin-import-bulk-actions">
            <label>
              <span>批量处理方式</span>
              <select
                aria-label="批量处理方式"
                value={bulkAction}
                disabled={busy !== null}
                onChange={(event) => setBulkAction(event.target.value as UserImportAction)}
              >
                <option value="add">{ACTION_LABELS.add}</option>
                <option value="overwrite">{ACTION_LABELS.overwrite}</option>
                <option value="skip">{ACTION_LABELS.skip}</option>
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={applyBulkDecision}
            >
              应用批量处理
            </button>
            <p>仅应用到允许该操作的行，已选确认项会随行保留。</p>
          </div>
          <div className="admin-import-table-wrap">
            <table className="admin-import-table">
              <thead>
                <tr>
                  <th>行号</th>
                  <th>姓名</th>
                  <th>手机号</th>
                  <th>分类</th>
                  <th>操作</th>
                  <th>确认项</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const decision = selectedDecision(row, decisions);
                  return (
                    <tr key={row.id}>
                      <td>{row.rowNumber}</td>
                      <td>{row.value?.name ?? Object.values(row.raw)[0] ?? "-"}</td>
                      <td>{row.value?.phone ?? "-"}</td>
                      <td>{row.category}</td>
                      <td>
                        <select
                          aria-label={`第 ${row.rowNumber} 行处理方式`}
                          value={decision.action}
                          disabled={!row.selectable || busy !== null}
                          onChange={(event) => updateDecision(row.id, {
                            action: event.target.value as UserImportAction
                          })}
                        >
                          {row.allowedActions.map((action) => (
                            <option value={action} key={action}>{ACTION_LABELS[action]}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <div className="admin-import-confirmations">
                          {row.conflicts.includes("wechat-occupied") && (
                            <label className="check-row">
                              <input
                                type="checkbox"
                                aria-label="确认换绑 WeChat 身份"
                                checked={decision.confirmWechatRebind}
                                disabled={decision.action === "skip" || busy !== null}
                                onChange={(event) => updateDecision(row.id, {
                                  confirmWechatRebind: event.target.checked
                                })}
                              />
                              确认换绑 WeChat 身份
                            </label>
                          )}
                          {row.conflicts.includes("wecom-occupied") && (
                            <label className="check-row">
                              <input
                                type="checkbox"
                                aria-label="确认换绑 WeCom 身份"
                                checked={decision.confirmWecomRebind}
                                disabled={decision.action === "skip" || busy !== null}
                                onChange={(event) => updateDecision(row.id, {
                                  confirmWecomRebind: event.target.checked
                                })}
                              />
                              确认换绑 WeCom 身份
                            </label>
                          )}
                          {!row.conflicts.some((conflict) => conflict.includes("occupied")) && <span>无需确认</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {decisionError && <p className="form-message" role="alert">{decisionError}</p>}
          {commitError && <p className="form-message" role="alert">{commitError}</p>}
          {commitMessage && <p className="form-message success" aria-live="polite">{commitMessage}</p>}
          <div className="admin-import-actions">
            <button className="primary-button" type="button" onClick={() => void commitImport()} disabled={busy !== null}>
              {busy === "commit" || busy === "save" ? "提交中..." : "提交导入"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void downloadReport()} disabled={busy !== null}>
              {busy === "report" ? "下载中..." : "下载导入报告"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
