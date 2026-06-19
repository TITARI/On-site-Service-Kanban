"use client";

import { useEffect, useRef, useState } from "react";

type ExhibitionProjectSelectorProps = {
  currentProjectName?: string;
  projects?: string[];
  onProjectChange?: (projectName: string) => void;
  onProjectCreate?: (projectName: string) => void;
};

function normalizeProjects(projects: string[] | undefined, currentProjectName: string) {
  const source = projects && projects.length > 0 ? projects : [currentProjectName];
  return Array.from(new Set([currentProjectName, ...source].map((project) => project.trim()).filter(Boolean)));
}

export function ExhibitionProjectSelector({
  currentProjectName = "第23届中原农资双交会",
  projects,
  onProjectChange,
  onProjectCreate
}: ExhibitionProjectSelectorProps) {
  const initialProjects = normalizeProjects(projects, currentProjectName);
  const [projectOptions, setProjectOptions] = useState<string[]>(initialProjects);
  const [selectedProjectName, setSelectedProjectName] = useState(currentProjectName);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const previousProjectNameRef = useRef(currentProjectName);

  useEffect(() => {
    if (previousProjectNameRef.current === currentProjectName) return;
    previousProjectNameRef.current = currentProjectName;
    setSelectedProjectName(currentProjectName);
    setProjectOptions((current) => current.includes(currentProjectName) ? current : [...current, currentProjectName]);
  }, [currentProjectName]);

  function handleProjectChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextProjectName = event.currentTarget.value;
    setSelectedProjectName(nextProjectName);
    onProjectChange?.(nextProjectName);
  }

  function openCreateDialog() {
    setProjectDraft("");
    setCreateDialogOpen(true);
  }

  function closeCreateDialog() {
    setCreateDialogOpen(false);
    setProjectDraft("");
  }

  function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextProjectName = projectDraft.trim();
    if (!nextProjectName) return;
    setProjectOptions((current) => current.includes(nextProjectName) ? current : [...current, nextProjectName]);
    setSelectedProjectName(nextProjectName);
    onProjectCreate?.(nextProjectName);
    onProjectChange?.(nextProjectName);
    closeCreateDialog();
  }

  return (
    <div className="exhibition-project-selector">
      <label className="exhibition-project-select">
        <span>当前展览项目</span>
        <select value={selectedProjectName} aria-label="当前展览项目" onChange={handleProjectChange}>
          {projectOptions.map((project) => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
      </label>
      <button className="secondary-button" type="button" onClick={openCreateDialog}>新建展览项目</button>

      {createDialogOpen && (
        <div className="exhibitor-assignment-layer">
          <button className="exhibitor-detail-scrim" type="button" aria-label="关闭新建展览项目" onClick={closeCreateDialog} />
          <section className="exhibitor-assignment-dialog" role="dialog" aria-modal="true" aria-label="新建展览项目">
            <div className="exhibitor-panel-head">
              <div>
                <h4>新建展览项目</h4>
                <p>创建后可继续导入对应项目的展商数据。</p>
              </div>
              <button className="ghost-button" type="button" aria-label="关闭新建展览项目" onClick={closeCreateDialog}>关闭</button>
            </div>
            <form className="exhibitor-type-form" onSubmit={createProject}>
              <label>
                <span>项目名称</span>
                <input
                  aria-label="项目名称"
                  autoFocus
                  value={projectDraft}
                  onChange={(event) => setProjectDraft(event.currentTarget.value)}
                />
              </label>
              <div className="exhibitor-detail-actions">
                <button className="secondary-button" type="button" onClick={closeCreateDialog}>取消</button>
                <button className="secondary-button" type="submit" disabled={!projectDraft.trim()}>创建项目</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
