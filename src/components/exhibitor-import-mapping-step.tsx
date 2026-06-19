"use client";

type MappingSource = "rule" | "ai" | "manual";

type ImportSheetPreview = {
  sheetName: string;
  selected: boolean;
  rows: number;
  importable?: boolean;
  aiError?: string;
  skippedReason?: string;
};

type ImportFieldMappingPreview = {
  sheetName: string;
  fieldLabel: string;
  sourceColumn: string;
  source: MappingSource;
  confidence?: number;
  reason: string;
  samples: string[];
  requiresConfirmation?: boolean;
};

const sourceLabels: Record<MappingSource, string> = {
  rule: "规则",
  ai: "AI",
  manual: "人工"
};

type ExhibitorImportMappingStepProps = {
  sheets: ImportSheetPreview[];
  mappings: ImportFieldMappingPreview[];
  isLoading?: boolean;
  message?: string | null;
  error?: string | null;
  canConfirm?: boolean;
  onToggleSheet: (sheetName: string, selected: boolean) => void;
  onConfirm: () => void;
};

export function ExhibitorImportMappingStep({
  sheets,
  mappings,
  isLoading = false,
  message,
  error,
  canConfirm = true,
  onToggleSheet,
  onConfirm
}: ExhibitorImportMappingStepProps) {
  return (
    <div className="exhibitor-import-stage">
      <div className="exhibitor-import-stage-head">
        <div>
          <h5>确认系统要读取哪些列</h5>
          <p>展位号和展商是主关联字段；位置、面积、类型进入看板；搭建商只用于匹配现场搭建组成员。</p>
        </div>
      </div>

      <div className="exhibitor-import-guides" aria-label="字段读取说明">
        <article>
          <strong>必须能识别</strong>
          <p>展位号、展商。缺一个就先回原表补齐或稍后在差异弹窗里修正。</p>
        </article>
        <article>
          <strong>面积自动识别</strong>
          <p>如果第二个“展位号”列样例是 36、18、54，系统会按面积读取。</p>
        </article>
        <article>
          <strong>智能识别只做辅助</strong>
          <p>规则看不准的列再交给高阶智能模型推导，最终仍以管理员确认结果为准。</p>
        </article>
      </div>

      {(message || error) && (
        <p className={`exhibitor-import-status${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          {error ?? message}
        </p>
      )}

      <div className="exhibitor-import-sheet-list" aria-label="可导入工作表">
        {sheets.length > 0 ? sheets.map((sheet) => (
          <label key={sheet.sheetName}>
            <input
              aria-label={`选择工作表 ${sheet.sheetName}`}
              type="checkbox"
              checked={sheet.selected}
              disabled={isLoading}
              onChange={(event) => onToggleSheet(sheet.sheetName, event.currentTarget.checked)}
            />
            <strong>{sheet.sheetName}</strong>
            <span>{sheet.rows} 行候选数据</span>
            {(sheet.skippedReason || sheet.aiError || sheet.importable === false) && (
              <small>{sheet.aiError ?? sheet.skippedReason ?? "未自动识别为可导入工作表，可手动勾选后重新预览"}</small>
            )}
          </label>
        )) : (
          <p className="exhibitor-empty-note">上传后会在这里列出工作簿里的真实工作表。</p>
        )}
      </div>

      <div className="exhibitor-import-table-wrap">
        <table className="exhibitor-import-mapping-table" aria-label="字段映射预览">
          <thead>
            <tr>
              <th scope="col">来源工作表</th>
              <th scope="col">系统字段</th>
              <th scope="col">来源列</th>
              <th scope="col">识别方式</th>
              <th scope="col">置信度</th>
              <th scope="col">样例值</th>
              <th scope="col">理由</th>
            </tr>
          </thead>
          <tbody>
            {mappings.length > 0 ? mappings.map((mapping) => (
              <tr key={`${mapping.sheetName}-${mapping.fieldLabel}-${mapping.sourceColumn}`}>
                <td>{mapping.sheetName}</td>
                <th scope="row">{mapping.fieldLabel}</th>
                <td>{mapping.sourceColumn}</td>
                <td><span className={`exhibitor-import-source ${mapping.source}`}>{sourceLabels[mapping.source]}</span></td>
                <td>{typeof mapping.confidence === "number" ? mapping.confidence.toFixed(2) : "需确认"}</td>
                <td><span className="sr-only">样例值</span>{mapping.samples.join(" / ") || "暂无样例"}</td>
                <td>{mapping.reason}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={7}>当前选中的工作表还没有可展示的字段映射。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="exhibitor-detail-actions">
        <button className="secondary-button" type="button" disabled={isLoading || !canConfirm} onClick={onConfirm}>
          {isLoading ? "正在生成预览..." : "确认字段映射"}
        </button>
      </div>
    </div>
  );
}

export type { ImportFieldMappingPreview, ImportSheetPreview };
