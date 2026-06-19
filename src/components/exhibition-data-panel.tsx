"use client";

import { ExhibitionProjectSelector } from "@/components/exhibition-project-selector";
import { ExhibitorDashboard } from "@/components/exhibitor-dashboard";
import type { BoothRecord } from "@/lib/domain/types";

type ExhibitionDataPanelProps = {
  booths: BoothRecord[];
  isImporting: boolean;
  onImportFile: (file: File, sheetNames?: string[]) => void | Promise<void>;
};

export function ExhibitionDataPanel({ booths, isImporting, onImportFile }: ExhibitionDataPanelProps) {
  return (
    <section className="exhibition-data-panel" role="region" aria-label="展览数据管理台">
      <ExhibitorDashboard
        booths={booths}
        isImporting={isImporting}
        onImportFile={onImportFile}
        projectSelector={<ExhibitionProjectSelector />}
      />
    </section>
  );
}
