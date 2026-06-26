"use client";

import { useMemo, useState } from "react";
import { ExhibitorImportMappingStep, type ImportFieldMappingPreview, type ImportSheetPreview } from "@/components/exhibitor-import-mapping-step";
import { ExhibitorImportPreviewStep, type PreviewDecisionKey, type PreviewDecisionState } from "@/components/exhibitor-import-preview-step";
import type { BoothRecord } from "@/lib/domain/types";

type ExhibitorImportWizardProps = {
  isImporting: boolean;
  onClose: () => void;
  onImportFile: (file: File, sheetNames?: string[]) => void | Promise<void>;
};

type ImportStep = "upload" | "mapping" | "preview" | "complete";
type InspectionStatus = "idle" | "loading" | "inspecting" | "ready" | "previewing" | "error";

type InspectResponse = {
  records?: BoothRecord[];
  errors?: Array<{ row: number; message: string }>;
  sheets?: ImportSheetPreview[];
  mappings?: ImportFieldMappingPreview[];
  error?: string;
  message?: string;
};

const initialDecisions: PreviewDecisionState = {
  new: false,
  changed: false,
  unmatchedBuilder: false
};

function selectedSheetNames(sheets: ImportSheetPreview[]) {
  return sheets.filter((sheet) => sheet.selected).map((sheet) => sheet.sheetName);
}

function responseError(payload: InspectResponse) {
  return payload.error ?? payload.message ?? payload.errors?.[0]?.message ?? "工作簿解析失败";
}

async function inspectWorkbook(file: File, sheetNames?: string[]) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("dryRun", "true");
  formData.append("inspect", "true");
  if (sheetNames) formData.append("sheetNames", JSON.stringify(sheetNames));
  const response = await fetch("/api/admin/master-data", {
    method: "POST",
    body: formData
  });
  const payload = await response.json() as InspectResponse;
  if (!response.ok) throw new Error(responseError(payload));
  return payload;
}

export function ExhibitorImportWizard({ isImporting, onClose, onImportFile }: ExhibitorImportWizardProps) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<ImportSheetPreview[]>([]);
  const [mappings, setMappings] = useState<ImportFieldMappingPreview[]>([]);
  const [previewRecords, setPreviewRecords] = useState<BoothRecord[]>([]);
  const [status, setStatus] = useState<InspectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<PreviewDecisionState>(initialDecisions);

  const selectedSheets = useMemo(() => new Set(selectedSheetNames(sheets)), [sheets]);
  const visibleMappings = mappings.filter((mapping) => selectedSheets.has(mapping.sheetName));
  const chosenSheetNames = selectedSheetNames(sheets);
  const isBusy = status === "inspecting" || status === "previewing";
  const canConfirmMapping = chosenSheetNames.length > 0 && status !== "error";
  const unmatchedBuilderCount = previewRecords.filter((record) => !record.builder?.trim()).length;

  async function prepareWorkbook(file: File) {
    setPendingFile(file);
    setStep("mapping");
    setSheets([]);
    setMappings([]);
    setPreviewRecords([]);
    setDecisions(initialDecisions);
    setStatus("inspecting");
    setStatusMessage("正在读取工作簿中的真实工作表，并用规则和智能模型生成字段映射...");
    try {
      const payload = await inspectWorkbook(file);
      const nextSheets = payload.sheets ?? [];
      setSheets(nextSheets);
      setMappings(payload.mappings ?? []);
      setPreviewRecords(payload.records ?? []);
      setStatus("ready");
      if (nextSheets.length === 0) {
        setStatusMessage("未读取到工作表，请检查文件内容后重新上传。");
      } else if (!nextSheets.some((sheet) => sheet.selected)) {
        setStatusMessage("已读取工作表，但暂未自动识别可导入数据；可勾选工作表后重新生成预览。");
      } else {
        setStatusMessage(`已读取 ${nextSheets.length} 张工作表，默认选择 ${nextSheets.filter((sheet) => sheet.selected).length} 张可导入工作表。`);
      }
    } catch (error) {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "工作簿解析失败，请重新上传。");
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void prepareWorkbook(file);
  }

  function toggleSheet(sheetName: string, selected: boolean) {
    setSheets((current) => current.map((sheet) => sheet.sheetName === sheetName ? { ...sheet, selected } : sheet));
    setStatus((current) => current === "error" ? "ready" : current);
    setStatusMessage(null);
  }

  function updateDecision(key: PreviewDecisionKey, checked: boolean) {
    setDecisions((current) => ({ ...current, [key]: checked }));
  }

  async function confirmMappings() {
    if (!pendingFile) return;
    if (chosenSheetNames.length === 0) {
      setStatus("ready");
      setStatusMessage("请至少选择一张工作表后再生成导入预览。");
      return;
    }
    setStatus("previewing");
    setStatusMessage("正在按已选工作表重新生成导入预览...");
    try {
      const payload = await inspectWorkbook(pendingFile, chosenSheetNames);
      setSheets(payload.sheets ?? sheets);
      setMappings(payload.mappings ?? mappings);
      setPreviewRecords(payload.records ?? []);
      setDecisions(initialDecisions);
      setStatus("ready");
      setStatusMessage(null);
      setStep("preview");
    } catch (error) {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "导入预览生成失败，请检查工作表选择。");
    }
  }

  async function applyImport() {
    if (!pendingFile) {
      setStep("complete");
      return;
    }
    try {
      setStatus("loading");
      setStatusMessage(null);
      await onImportFile(pendingFile, chosenSheetNames);
      setStep("complete");
    } catch (error) {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "导入失败，请重试或联系管理员");
    }
  }

  return (
    <div className="exhibitor-assignment-layer">
      <button className="exhibitor-detail-scrim" type="button" aria-label="关闭展商数据导入向导" onClick={onClose} />
      <section className="exhibitor-assignment-dialog exhibitor-import-wizard" role="dialog" aria-modal="true" aria-label="展商数据导入向导">
        <div className="exhibitor-panel-head">
          <div>
            <h4>展商数据导入向导</h4>
            <p>按项目上传本地工作簿，系统先预览、再确认、最后写入看板。</p>
          </div>
          <button className="ghost-button" type="button" aria-label="关闭展商数据导入向导" onClick={onClose}>关闭</button>
        </div>

        <ol className="exhibitor-import-steps" aria-label="导入步骤">
          <li aria-current={step === "upload" ? "step" : undefined}>1 上传工作簿</li>
          <li aria-current={step === "mapping" ? "step" : undefined}>2 确认读取字段</li>
          <li aria-current={step === "preview" ? "step" : undefined}>3 预览并写入</li>
        </ol>

        {step === "upload" && (
          <div className="exhibitor-import-dropzone">
            <strong>{isImporting ? "正在导入项目表格..." : "上传项目表格"}</strong>
            <p>上传后先进入预览，不会立刻覆盖后台数据。</p>
            <div className="exhibitor-import-guide-card">
              <strong>系统会保留什么</strong>
              <p>系统只保留展位号、展商、位置、面积、类型、销售和现场搭建成员；原表其他列不会写入看板。</p>
            </div>
            <label className="exhibitor-upload-button">
              <span>{isImporting ? "导入中..." : "选择工作簿"}</span>
              <input type="file" accept=".xlsx,.xls,.csv" disabled={isImporting} aria-label="导入展位数据文件" onChange={handleFileChange} />
            </label>
          </div>
        )}

        {step === "mapping" && (
          <ExhibitorImportMappingStep
            sheets={sheets}
            mappings={visibleMappings}
            isLoading={isBusy}
            message={status === "error" ? null : statusMessage}
            error={status === "error" ? statusMessage : null}
            canConfirm={canConfirmMapping}
            onToggleSheet={toggleSheet}
            onConfirm={() => void confirmMappings()}
          />
        )}

        {step === "preview" && (
          <>
            {status === "loading" && <div className="exhibitor-import-status loading-message" role="status">导入中...</div>}
            {status === "error" && statusMessage && <div className="exhibitor-import-status error error-message" role="alert">{statusMessage}</div>}
            <ExhibitorImportPreviewStep
              decisions={decisions}
              recordCount={previewRecords.length}
              unmatchedBuilderCount={unmatchedBuilderCount}
              candidate={previewRecords[0]}
              onDecisionChange={updateDecision}
              onBack={() => setStep("mapping")}
              onApply={() => void applyImport()}
            />
          </>
        )}

        {step === "complete" && (
          <div className="exhibitor-import-complete" role="status" aria-live="polite">
            <strong>导入确认已提交</strong>
            <p>系统将按管理员确认的工作表、读取字段和预览决策写入展商数据看板。</p>
            <button className="secondary-button" type="button" onClick={onClose}>关闭向导</button>
          </div>
        )}
      </section>
    </div>
  );
}
