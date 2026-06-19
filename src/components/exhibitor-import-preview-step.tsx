"use client";

import type { BoothRecord } from "@/lib/domain/types";

type PreviewDecisionKey = "new" | "changed" | "unmatchedBuilder";

type PreviewDecisionState = Record<PreviewDecisionKey, boolean>;

type ExhibitorImportPreviewStepProps = {
  decisions: PreviewDecisionState;
  recordCount: number;
  unmatchedBuilderCount: number;
  candidate?: BoothRecord;
  onDecisionChange: (key: PreviewDecisionKey, checked: boolean) => void;
  onBack: () => void;
  onApply: () => void;
};

function display(value?: string) {
  return value?.trim() || "待补充";
}

export function ExhibitorImportPreviewStep({
  decisions,
  recordCount,
  unmatchedBuilderCount,
  candidate,
  onDecisionChange,
  onBack,
  onApply
}: ExhibitorImportPreviewStepProps) {
  const canApply = Object.values(decisions).every(Boolean) && recordCount > 0;
  const previewGroups: Array<{
    key: PreviewDecisionKey;
    title: string;
    count: number;
    description: string;
    label: string;
    summary: string;
  }> = [
    {
      key: "new",
      title: "候选展商",
      count: recordCount,
      description: "当前选中工作表解析出的系统展商，确认后会进入现有展商数据导入流程。",
      label: "我已确认候选展商会写入看板",
      summary: recordCount > 0 ? "会写入看板" : "没有可写入数据"
    },
    {
      key: "changed",
      title: "字段取值",
      count: recordCount,
      description: "系统只保留字段映射确认后的展位号、展商、位置、面积、类型、销售和搭建成员。",
      label: "我已确认字段取值的处理方式",
      summary: "确认后的字段会写入看板"
    },
    {
      key: "unmatchedBuilder",
      title: "搭建成员待分配",
      count: unmatchedBuilderCount,
      description: "没有搭建成员的展商仍会导入，后续可在看板里继续分配现场搭建成员。",
      label: "我已了解未匹配成员会进入待分配",
      summary: unmatchedBuilderCount > 0 ? "未匹配成员会进入待分配" : "当前没有待分配成员"
    }
  ];

  return (
    <div className="exhibitor-import-stage">
      <div className="exhibitor-import-stage-head">
        <div>
          <h5>预览导入结果，确认后才写入</h5>
          <p>勾选每一类代表你已看过处理方式；未勾选时不能写入看板。</p>
        </div>
      </div>

      <div className="exhibitor-import-preview-notes" aria-label="导入结果说明">
        <article>
          <strong>会写入看板</strong>
          <p>选中工作表解析出的展商，以及字段映射确认后的业务字段。</p>
        </article>
        <article>
          <strong>不会保存</strong>
          <p>原表中和看板无关的列、智能推理过程和临时样例值。</p>
        </article>
      </div>

      <div className="exhibitor-import-preview-grid" aria-label="导入预览分组">
        {previewGroups.map((group) => (
          <article key={group.key}>
            <div>
              <strong>{group.title}</strong>
              <span>{group.count} 条</span>
            </div>
            <small>{group.summary}</small>
            <p>{group.description}</p>
            <label>
              <input
                aria-label={group.label}
                type="checkbox"
                checked={decisions[group.key]}
                onChange={(event) => onDecisionChange(group.key, event.currentTarget.checked)}
              />
              <span>{group.label}</span>
            </label>
          </article>
        ))}
      </div>

      <div className="exhibitor-import-candidate-card" aria-label="候选展商示例">
        {candidate ? (
          <>
            <strong>{candidate.companyName}</strong>
            <span>{candidate.boothNumber} / {display(candidate.location)} / {display(candidate.area)} / {display(candidate.boothType)}</span>
            <small>这是当前选中工作表解析出的第一条候选展商；正式看板只保留确认后的业务字段。</small>
          </>
        ) : (
          <>
            <strong>没有可写入的候选展商</strong>
            <span>返回字段映射，至少选择一张能识别展位号和展商的工作表。</span>
            <small>正式导入不会保存无法映射到系统字段的原始列。</small>
          </>
        )}
      </div>

      <div className="exhibitor-detail-actions">
        <button className="secondary-button" type="button" onClick={onBack}>返回字段映射</button>
        <button className="secondary-button" type="button" disabled={!canApply} onClick={onApply}>确认并写入看板</button>
      </div>
    </div>
  );
}

export type { PreviewDecisionKey, PreviewDecisionState };
