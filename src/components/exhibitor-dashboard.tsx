"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ExhibitorImportWizard } from "@/components/exhibitor-import-wizard";
import type { BoothRecord } from "@/lib/domain/types";

function displayText(value?: string) {
  const text = value?.trim();
  return text || "—";
}

function areaDisplayParts(value?: string) {
  const area = value?.trim();
  if (!area) return { primary: "—", spec: "规格待补充" };
  const numeric = area.match(/^\d+(?:\.\d+)?$/)?.[0];
  if (numeric === "9") return { primary: "9㎡", spec: "3×3m" };
  if (numeric) return { primary: `${numeric}㎡`, spec: "规格待补充" };
  const [primary, ...rest] = area.split(/[\/|]/).map((part) => part.trim()).filter(Boolean);
  const primaryNumeric = primary?.match(/^\d+(?:\.\d+)?$/)?.[0];
  return { primary: primaryNumeric ? `${primaryNumeric}㎡` : primary || area, spec: rest.join(" / ") || "规格待补充" };
}

function AreaDisplay({ value }: { value?: string }) {
  const area = areaDisplayParts(value);
  return (
    <span className="exhibitor-area">
      <strong>{area.primary}</strong>
      <small>{area.spec}</small>
    </span>
  );
}

type BuilderMember = {
  name: string;
  phone?: string;
};
type DashboardBoothRecord = BoothRecord & {
  enabled?: boolean;
};

type AssignmentFilter = "all" | "assigned" | "unassigned";
type DashboardPanel = "history" | null;
type BoothEditorDraft = {
  boothNumber: string;
  companyName: string;
  location: string;
  area: string;
  areaSpecification: string;
  boothType: string;
  salesOwner: string;
};
type AssignmentDialogState =
  | { mode: "single"; booth: DashboardBoothRecord }
  | { mode: "bulk" };
type ManagedExhibitorType = {
  id: string;
  name: string;
  enabled: boolean;
};
type PaginationItem = number | "ellipsis-left" | "ellipsis-right";
type BoothDiffDraft = {
  boothNumber: string;
  companyName: string;
  location: string;
  area: string;
  boothType: string;
};

const EXHIBITOR_PAGE_SIZE = 10;
const EXHIBITOR_PAGE_SIZE_OPTIONS = [EXHIBITOR_PAGE_SIZE, 20, 30, 50, 100];
const useTypeDialogScope = Dialog.createDialogScope();
const useAssignmentDialogScope = Dialog.createDialogScope();
const useDiffDialogScope = Dialog.createDialogScope();
const useEditDialogScope = Dialog.createDialogScope();
const useBatchTypeDialogScope = Dialog.createDialogScope();

const DEFAULT_MANAGED_TYPES: ManagedExhibitorType[] = [
  { id: "ordinary-green", name: "普通绿搭", enabled: true },
  { id: "standard", name: "普标", enabled: true },
  { id: "premium-standard", name: "精标", enabled: true }
];

function boothRecordKey(booth: Pick<BoothRecord, "boothNumber" | "companyName">) {
  return `${booth.boothNumber}::${booth.companyName}`;
}

function isAssignedBooth(booth: DashboardBoothRecord) {
  return Boolean(booth.builder?.trim());
}

function boothSearchText(booth: DashboardBoothRecord) {
  return [
    booth.boothNumber,
    booth.companyName,
    booth.companyShortName,
    booth.location,
    booth.area,
    booth.boothType,
    booth.salesOwner,
    booth.builder
  ].filter(Boolean).join(" ").toLowerCase();
}

function uniqueDisplayValues(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function managedTypeIdFor(name: string, index: number) {
  return `custom-${index}-${name.trim().replace(/\s+/g, "-")}`;
}

function uniqueBuilderMemberNames(booths: DashboardBoothRecord[]) {
  return Array.from(new Set(booths.flatMap((booth) => builderMembersOf(booth.builder).map((member) => member.name)))).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function builderMembersOf(builder?: string): BuilderMember[] {
  const text = builder?.trim();
  if (!text) return [];
  return text
    .split(/[、,，;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawName, ...rawPhoneParts] = item.split(/[：:]/);
      const name = rawName.trim() || item;
      const phone = rawPhoneParts.join(":").trim();
      return phone ? { name, phone } : { name };
    });
}

function memberInitialOf(name: string) {
  return name.trim().charAt(0) || "?";
}

function maskedPhone(phone?: string) {
  const digits = phone?.replace(/\D/g, "");
  if (!digits || digits.length < 7) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function isImportDiffBooth(booth: DashboardBoothRecord) {
  return !booth.boothNumber?.trim()
    || !booth.companyName?.trim()
    || !booth.location?.trim()
    || !booth.area?.trim()
    || !booth.boothType?.trim();
}

function buildPaginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis-right", totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [1, "ellipsis-left", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis-left", currentPage - 1, currentPage, currentPage + 1, "ellipsis-right", totalPages];
}

function updateBoothRecord(
  booths: DashboardBoothRecord[],
  targetKey: string,
  updater: (booth: DashboardBoothRecord) => DashboardBoothRecord
) {
  return booths.map((booth) => boothRecordKey(booth) === targetKey ? updater(booth) : booth);
}

function buildDiffDraft(booth: DashboardBoothRecord): BoothDiffDraft {
  return {
    boothNumber: booth.boothNumber?.trim() || "",
    companyName: booth.companyName?.trim() || "",
    location: booth.location?.trim() || "",
    area: booth.area?.trim() || "",
    boothType: booth.boothType?.trim() || ""
  };
}

export function ExhibitorDashboard({
  booths: incomingBooths,
  isImporting,
  onImportFile,
  showShell = true,
  projectSelector
}: {
  booths: BoothRecord[];
  isImporting: boolean;
  onImportFile: (file: File, sheetNames?: string[]) => void | Promise<void>;
  showShell?: boolean;
  projectSelector?: ReactNode;
}) {
  const typeDialogScope = useTypeDialogScope(undefined);
  const assignmentDialogScope = useAssignmentDialogScope(undefined);
  const diffDialogScope = useDiffDialogScope(undefined);
  const editDialogScope = useEditDialogScope(undefined);
  const batchTypeDialogScope = useBatchTypeDialogScope(undefined);
  const [booths, setBooths] = useState<DashboardBoothRecord[]>(() => incomingBooths.map((booth) => ({ ...booth, enabled: true })));
  const [searchQuery, setSearchQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>("all");
  const [memberFilter, setMemberFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(EXHIBITOR_PAGE_SIZE);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [activeBooth, setActiveBooth] = useState<DashboardBoothRecord | null>(null);
  const [detailTriggerId, setDetailTriggerId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<DashboardPanel>(null);
  const [assignmentDialog, setAssignmentDialog] = useState<AssignmentDialogState | null>(null);
  const [assignmentTriggerId, setAssignmentTriggerId] = useState<string | null>(null);
  const [assignmentMemberNames, setAssignmentMemberNames] = useState<Set<string>>(() => new Set());
  const [typeDialogOpen, setTypeDialogOpen] = useState(false);
  const [importWizardOpen, setImportWizardOpen] = useState(false);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [batchTypeDialogOpen, setBatchTypeDialogOpen] = useState(false);
  const [batchDisableDialogOpen, setBatchDisableDialogOpen] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [batchTypeName, setBatchTypeName] = useState("普通绿搭");
  const [diffDrafts, setDiffDrafts] = useState<Record<string, BoothDiffDraft>>({});
  const [editingBooth, setEditingBooth] = useState<{ originalKey: string; draft: BoothEditorDraft } | null>(null);
  const [managedTypes, setManagedTypes] = useState<ManagedExhibitorType[]>(() => DEFAULT_MANAGED_TYPES);
  const [typeNameDrafts, setTypeNameDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setBooths(incomingBooths.map((booth) => ({ ...booth, enabled: true })));
    setCurrentPage(1);
  }, [incomingBooths]);

  const locationOptions = uniqueDisplayValues(booths.map((booth) => booth.location));
  const typeOptions = uniqueDisplayValues([
    ...managedTypes.filter((type) => type.enabled).map((type) => type.name),
    ...booths.map((booth) => booth.boothType)
  ]);
  const memberOptions = uniqueBuilderMemberNames(booths);
  const sameBoothCounts = booths.reduce((counts, booth) => {
    const key = booth.boothNumber.trim();
    if (!key) return counts;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredBooths = booths.filter((booth) => {
    if (normalizedQuery && !boothSearchText(booth).includes(normalizedQuery)) return false;
    if (locationFilter !== "all" && booth.location?.trim() !== locationFilter) return false;
    if (typeFilter !== "all" && booth.boothType?.trim() !== typeFilter) return false;
    if (assignmentFilter === "assigned" && !isAssignedBooth(booth)) return false;
    if (assignmentFilter === "unassigned" && isAssignedBooth(booth)) return false;
    if (memberFilter !== "all" && !builderMembersOf(booth.builder).some((member) => member.name === memberFilter)) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredBooths.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * pageSize;
  const pageEndIndex = filteredBooths.length === 0 ? 0 : Math.min(pageStartIndex + pageSize, filteredBooths.length);
  const paginatedBooths = filteredBooths.slice(pageStartIndex, pageStartIndex + pageSize);
  const paginationItems = buildPaginationItems(safeCurrentPage, totalPages);
  const visibleKeys = paginatedBooths.map(boothRecordKey);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key));
  const assignedCount = booths.filter(isAssignedBooth).length;
  const unassignedCount = Math.max(booths.length - assignedCount, 0);
  const importDiffCount = booths.filter(isImportDiffBooth).length;
  const importDiffBooths = booths.filter(isImportDiffBooth);
  const importDiffRows = importDiffBooths.map((booth) => {
    const key = boothRecordKey(booth);
    return {
      booth,
      key,
      draft: diffDrafts[key] ?? buildDiffDraft(booth)
    };
  });
  const allDiffDraftsComplete = importDiffRows.length > 0 && importDiffRows.every((row) => {
    const draft = diffDrafts[row.key] ?? row.draft;
    return Boolean(
      draft.boothNumber.trim()
      && draft.companyName.trim()
      && draft.location.trim()
      && draft.area.trim()
      && draft.boothType.trim()
    );
  });
  const selectedBooths = booths.filter((booth) => selectedKeys.has(boothRecordKey(booth)));
  const activeMembers = builderMembersOf(activeBooth?.builder);
  const assignedPercent = booths.length > 0 ? Math.round((assignedCount / booths.length) * 100) : 0;
  const availableBuilderMembers = ["李铁", "崔晓安", "王宁", "刘文博"];
  const shellOverviewCopy = {
    system: "来自 2 张有效工作表",
    assigned: `${assignedPercent}% 已完成成员关联`,
    unassigned: "可按展馆批量分配",
    diff: "不影响当前系统数据"
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [normalizedQuery, locationFilter, typeFilter, assignmentFilter, memberFilter]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setCurrentPage(1);
  }, [pageSize]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) void onImportFile(file);
    event.currentTarget.value = "";
  }

  function toggleSelected(key: string, checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleVisible(checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      visibleKeys.forEach((key) => {
        if (checked) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  }

  function addManagedType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newTypeName.trim();
    if (!name) return;
    setManagedTypes((current) => {
      const existing = current.find((type) => type.name === name);
      if (existing) {
        return current.map((type) => type.id === existing.id ? { ...type, enabled: true } : type);
      }
      return [...current, { id: managedTypeIdFor(name, current.length), name, enabled: true }];
    });
    setNewTypeName("");
  }

  function updateTypeNameDraft(typeId: string, name: string) {
    setTypeNameDrafts((current) => ({
      ...current,
      [typeId]: name
    }));
  }

  function openDiffDialog() {
    setDiffDrafts(
      importDiffBooths.reduce((next, booth) => {
        next[boothRecordKey(booth)] = buildDiffDraft(booth);
        return next;
      }, {} as Record<string, BoothDiffDraft>)
    );
    setDiffDialogOpen(true);
  }

  function updateDiffDraft(boothKey: string, field: keyof BoothDiffDraft, value: string) {
    setDiffDrafts((current) => ({
      ...current,
      [boothKey]: {
        ...(current[boothKey] ?? { boothNumber: "", companyName: "", location: "", area: "", boothType: "" }),
        [field]: value
      }
    }));
  }

  function closeDiffDialog() {
    setDiffDrafts({});
    setDiffDialogOpen(false);
  }

  function applyDiffRows() {
    if (importDiffRows.length === 0) {
      setDiffDialogOpen(false);
      return;
    }
    setBooths((current) => importDiffRows.reduce((nextBooths, row) => updateBoothRecord(nextBooths, row.key, (booth) => {
      const nextDraft = diffDrafts[row.key] ?? row.draft;
      return {
        ...booth,
        boothNumber: nextDraft.boothNumber.trim() || booth.boothNumber,
        companyName: nextDraft.companyName.trim() || booth.companyName,
        companyShortName: booth.companyShortName?.trim() || nextDraft.companyName.trim() || booth.companyName,
        location: nextDraft.location.trim() || booth.location,
        area: nextDraft.area.trim() || booth.area,
        boothType: nextDraft.boothType.trim() || booth.boothType
      };
    }), current));
    setActiveBooth((current) => {
      if (!current) return current;
      const match = importDiffRows.find((row) => boothRecordKey(row.booth) === boothRecordKey(current));
      if (!match) return current;
      const nextDraft = diffDrafts[match.key] ?? match.draft;
      return {
        ...current,
        boothNumber: nextDraft.boothNumber.trim() || current.boothNumber,
        companyName: nextDraft.companyName.trim() || current.companyName,
        companyShortName: current.companyShortName?.trim() || nextDraft.companyName.trim() || current.companyName,
        location: nextDraft.location.trim() || current.location,
        area: nextDraft.area.trim() || current.area,
        boothType: nextDraft.boothType.trim() || current.boothType
      };
    });
    setDiffDrafts({});
    setDiffDialogOpen(false);
  }

  function saveManagedTypeName(type: ManagedExhibitorType) {
    const nextName = (typeNameDrafts[type.id] ?? type.name).trim();
    if (!nextName || nextName === type.name) return;
    setManagedTypes((current) => {
      if (current.some((item) => item.id !== type.id && item.name === nextName)) return current;
      return current.map((item) => item.id === type.id ? { ...item, name: nextName } : item);
    });
    setBooths((current) => current.map((booth) => booth.boothType === type.name ? { ...booth, boothType: nextName } : booth));
    setActiveBooth((current) => current && current.boothType === type.name ? { ...current, boothType: nextName } : current);
    setEditingBooth((current) => current?.draft.boothType === type.name ? {
      ...current,
      draft: { ...current.draft, boothType: nextName }
    } : current);
    if (typeFilter === type.name) setTypeFilter(nextName);
    if (batchTypeName === type.name) setBatchTypeName(nextName);
    setTypeNameDrafts((current) => {
      const { [type.id]: _removed, ...rest } = current;
      return rest;
    });
  }

  function moveManagedType(typeId: string, direction: -1 | 1) {
    setManagedTypes((current) => {
      const index = current.findIndex((type) => type.id === typeId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function setManagedTypeEnabled(typeId: string, enabled: boolean) {
    setManagedTypes((current) => current.map((type) => type.id === typeId ? { ...type, enabled } : type));
  }

  function openEditDialog(booth: DashboardBoothRecord) {
    setEditingBooth({
      originalKey: boothRecordKey(booth),
      draft: {
        boothNumber: booth.boothNumber,
        companyName: booth.companyName,
        location: booth.location ?? "",
        area: booth.area ?? "",
        areaSpecification: areaDisplayParts(booth.area).spec,
        boothType: booth.boothType ?? "",
        salesOwner: booth.salesOwner
      }
    });
  }

  function updateEditDraft(field: keyof BoothEditorDraft, value: string) {
    setEditingBooth((current) => current ? {
      ...current,
      draft: {
        ...current.draft,
        [field]: value
      }
    } : current);
  }

  function saveEditedBooth() {
    if (!editingBooth) return;
    const originalKey = editingBooth.originalKey;
    const nextDraft = editingBooth.draft;
    const original = booths.find((booth) => boothRecordKey(booth) === originalKey);
    if (!original) return;

    const nextBooth: DashboardBoothRecord = {
      boothNumber: nextDraft.boothNumber.trim(),
      companyName: nextDraft.companyName.trim(),
      companyShortName: original.companyShortName?.trim() || nextDraft.companyName.trim(),
      salesOwner: nextDraft.salesOwner.trim(),
      builder: original.builder,
      enabled: original.enabled
    };
    if (nextDraft.location.trim()) nextBooth.location = nextDraft.location.trim();
    if (nextDraft.area.trim()) nextBooth.area = nextDraft.area.trim();
    if (nextDraft.areaSpecification.trim()) {
      nextBooth.area = `${nextDraft.area.trim()} / ${nextDraft.areaSpecification.trim()}`;
    }
    if (nextDraft.boothType.trim()) nextBooth.boothType = nextDraft.boothType.trim();

    setBooths((current) => current.map((booth) => boothRecordKey(booth) === originalKey ? nextBooth : booth));
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.delete(originalKey)) next.add(boothRecordKey(nextBooth));
      return next;
    });
    setActiveBooth((current) => current && boothRecordKey(current) === originalKey ? nextBooth : current);
    setEditingBooth(null);
  }

  function openBatchTypeDialog() {
    const firstSelected = selectedBooths[0];
    setBatchTypeName(firstSelected?.boothType?.trim() || typeOptions[0] || "普通绿搭");
    setBatchTypeDialogOpen(true);
  }

  function saveBatchType() {
    const nextType = batchTypeName.trim();
    if (!nextType) return;
    setBooths((current) => current.map((booth) => selectedKeys.has(boothRecordKey(booth)) ? { ...booth, boothType: nextType } : booth));
    setManagedTypes((current) => current.some((type) => type.name === nextType)
      ? current
      : [...current, { id: managedTypeIdFor(nextType, current.length), name: nextType, enabled: true }]);
    setBatchTypeDialogOpen(false);
  }

  function toggleAssignmentMember(name: string, checked: boolean) {
    setAssignmentMemberNames((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function builderTextForNames(names: string[], sourceBooths: DashboardBoothRecord[]) {
    return names.map((name) => {
      const existingMember = sourceBooths
        .flatMap((booth) => builderMembersOf(booth.builder))
        .find((member) => member.name === name && member.phone);
      return existingMember?.phone ? `${name}：${existingMember.phone}` : name;
    }).join("、");
  }

  function saveAssignment() {
    if (!assignmentDialog) return;
    const targetKeys = assignmentDialog.mode === "bulk"
      ? new Set(selectedKeys)
      : new Set([boothRecordKey(assignmentDialog.booth)]);
    const sourceBooths = assignmentDialog.mode === "bulk" ? selectedBooths : [assignmentDialog.booth];
    const nextBuilder = builderTextForNames([...assignmentMemberNames], sourceBooths);

    setBooths((current) => current.map((booth) => targetKeys.has(boothRecordKey(booth)) ? {
      ...booth,
      builder: nextBuilder
    } : booth));
    setActiveBooth((current) => current && targetKeys.has(boothRecordKey(current)) ? {
      ...current,
      builder: nextBuilder
    } : current);
    setAssignmentDialog(null);
  }

  function setBoothEnabled(booth: DashboardBoothRecord, enabled: boolean) {
    const targetKey = boothRecordKey(booth);
    setBooths((current) => current.map((item) => boothRecordKey(item) === targetKey ? { ...item, enabled } : item));
    setActiveBooth((current) => current && boothRecordKey(current) === targetKey ? { ...current, enabled } : current);
    setSelectedKeys((current) => {
      if (enabled || !current.has(targetKey)) return current;
      const next = new Set(current);
      next.delete(targetKey);
      return next;
    });
  }

  function batchDisableSelectedBooths() {
    const targetKeys = new Set(selectedKeys);
    setBooths((current) => current.map((booth) => targetKeys.has(boothRecordKey(booth)) ? { ...booth, enabled: false } : booth));
    setActiveBooth((current) => current && targetKeys.has(boothRecordKey(current)) ? { ...current, enabled: false } : current);
    setSelectedKeys(new Set());
    setBatchDisableDialogOpen(false);
  }

  function closeDetailDrawer() {
    setActiveBooth(null);
    setEditingBooth(null);
  }

  function goToPage(page: number) {
    setCurrentPage(Math.min(Math.max(page, 1), totalPages));
  }

  function handlePageSizeChange(event: React.ChangeEvent<HTMLSelectElement>) {
    setPageSize(Number(event.currentTarget.value));
  }

  function renderDetailTrigger(booth: DashboardBoothRecord, surface: "table" | "card") {
    const triggerId = `${surface}:${boothRecordKey(booth)}`;
    const button = (
      <button
        className="table-action"
        type="button"
        aria-label={`查看${booth.companyName}`}
        onClick={() => {
          setDetailTriggerId(triggerId);
          setActiveBooth(booth);
        }}
      >
        查看
      </button>
    );
    return detailTriggerId === triggerId ? <Dialog.Trigger asChild>{button}</Dialog.Trigger> : button;
  }

  function openAssignmentDialog(nextDialog: AssignmentDialogState, triggerId: string) {
    setAssignmentTriggerId(triggerId);
    setAssignmentDialog(nextDialog);
  }

  function renderAssignmentTrigger(triggerId: string, button: ReactElement) {
    return assignmentTriggerId === triggerId
      ? <Dialog.Trigger {...assignmentDialogScope} asChild>{button}</Dialog.Trigger>
      : button;
  }

  useEffect(() => {
    if (!assignmentDialog) {
      setAssignmentMemberNames(new Set());
      return;
    }
    if (assignmentDialog.mode === "single") {
      setAssignmentMemberNames(new Set(builderMembersOf(assignmentDialog.booth.builder).map((member) => member.name)));
      return;
    }
    setAssignmentMemberNames(new Set());
  }, [assignmentDialog]);

  return (
    <Dialog.Root
      open={Boolean(activeBooth)}
      onOpenChange={(open) => {
        if (!open) closeDetailDrawer();
      }}
    >
      <Dialog.Root {...typeDialogScope} open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
        <Dialog.Root
          {...assignmentDialogScope}
          open={Boolean(assignmentDialog)}
          onOpenChange={(open) => {
            if (!open) setAssignmentDialog(null);
          }}
        >
          <Dialog.Root
            {...diffDialogScope}
            open={diffDialogOpen}
            onOpenChange={(open) => {
              if (open) openDiffDialog();
              else closeDiffDialog();
            }}
          >
            <Dialog.Root
              {...editDialogScope}
              open={Boolean(editingBooth)}
              onOpenChange={(open) => {
                if (!open) setEditingBooth(null);
              }}
            >
              <Dialog.Root
                {...batchTypeDialogScope}
                open={batchTypeDialogOpen}
                onOpenChange={(open) => {
                  if (!open) setBatchTypeDialogOpen(false);
                }}
              >
                <AlertDialog.Root open={batchDisableDialogOpen} onOpenChange={setBatchDisableDialogOpen}>
                  <section className="exhibitor-dashboard" id="admin-master-data" aria-labelledby="exhibitor-dashboard-title">
      {showShell && (
        <>
          <div className="exhibitor-dashboard-topbar">
            <span>管理后台 / 展商数据</span>
            <div className="exhibitor-top-actions">
              <button className="secondary-button" type="button" onClick={() => setActivePanel((current) => current === "history" ? null : "history")}>导入历史</button>
              <div className="exhibitor-admin-user">
                <span>管</span>
                <div><strong>管理员</strong><small>项目数据权限</small></div>
              </div>
            </div>
          </div>
          <div className="exhibitor-page-head">
            <div>
              <p className="eyebrow">展商数据</p>
              <h3 id="exhibitor-dashboard-title">展商数据看板</h3>
              <p>以展位号与展商为核心，统一管理项目展商资料和现场搭建成员。</p>
            </div>
            {projectSelector ?? (
              <label className="exhibition-project-select">
                <span>当前展览项目</span>
                <select defaultValue="第23届中原农资双交会">
                  <option value="第23届中原农资双交会">第23届中原农资双交会</option>
                </select>
              </label>
            )}
          </div>
        </>
      )}
      {!showShell && <span id="exhibitor-dashboard-title" className="sr-only">展商数据明细</span>}

      <div className="exhibitor-metrics" aria-label="项目数据概览">
        <article className="exhibitor-metric">
          <span>系统展商</span>
          <strong>{booths.length}</strong>
          <small>{showShell ? shellOverviewCopy.system : "展位主数据已入库"}</small>
        </article>
        <article className="exhibitor-metric success">
          <span>已分配搭建成员</span>
          <strong>{assignedCount}</strong>
          <small>{showShell ? shellOverviewCopy.assigned : "可直接联动现场工单"}</small>
        </article>
        <article className="exhibitor-metric warning">
          <span>待分配成员</span>
          <strong>{unassignedCount}</strong>
          <small>{showShell ? shellOverviewCopy.unassigned : "建议导入后优先补齐"}</small>
        </article>
        <article className="exhibitor-metric danger">
          <span>待确认导入差异</span>
          <strong>{importDiffCount}</strong>
          <small>{showShell ? shellOverviewCopy.diff : "缺少位置、面积或类型"}</small>
        </article>
      </div>

      <div className="exhibitor-workspace">
        <div className="exhibitor-toolbar">
          <div className="exhibitor-toolbar-left">
            <label className="exhibitor-search">
              <span className="sr-only">搜索展商数据</span>
              <input
                type="search"
                placeholder="搜索展位、展商、销售、搭建成员"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
            </label>
            <select aria-label="按位置筛选" value={locationFilter} onChange={(event) => setLocationFilter(event.currentTarget.value)}>
              <option value="all">全部位置</option>
              {locationOptions.map((location) => (
                <option key={location} value={location}>{location}</option>
              ))}
            </select>
            <select aria-label="按类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value)}>
              <option value="all">全部类型</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <Dialog.Trigger {...typeDialogScope} asChild>
              <button className="exhibitor-filter-button" type="button">类型设置</button>
            </Dialog.Trigger>
            <select aria-label="按成员分配状态筛选" value={assignmentFilter} onChange={(event) => setAssignmentFilter(event.currentTarget.value as AssignmentFilter)}>
              <option value="all">全部分配状态</option>
              <option value="assigned">仅看已分配</option>
              <option value="unassigned">仅看待分配</option>
            </select>
            <select aria-label="按现场搭建成员筛选" value={memberFilter} onChange={(event) => setMemberFilter(event.currentTarget.value)}>
              <option value="all">按现场搭建成员筛选</option>
              {memberOptions.map((memberName) => (
                <option key={memberName} value={memberName}>{memberName}</option>
              ))}
            </select>
          </div>
          <div className="exhibitor-toolbar-right">
            <Dialog.Trigger {...diffDialogScope} asChild>
              <button
                className={`exhibitor-diff-action ${importDiffCount > 0 ? "pending" : ""}`}
                type="button"
                aria-label="处理导入差异"
              >
                <span>处理导入差异</span>
                <strong>{importDiffCount}</strong>
                <small>待确认</small>
                <span className="sr-only">{importDiffCount} 条导入差异待确认</span>
              </button>
            </Dialog.Trigger>
            {!showShell && (
              <button className="secondary-button" type="button" onClick={() => setActivePanel((current) => current === "history" ? null : "history")}>导入历史</button>
            )}
            <button className="exhibitor-upload-button" type="button" disabled={isImporting} onClick={() => setImportWizardOpen(true)}>
              {isImporting ? "导入中..." : "上传项目表格"}
            </button>
            <label className="sr-only">
              导入展位数据文件
              <input type="file" accept=".xlsx,.xls,.csv" disabled={isImporting} onChange={handleFileChange} />
            </label>
          </div>
        </div>

        {activePanel === "history" && (
          <section className="exhibitor-insight-panel" role="region" aria-label="导入历史面板">
            <div className="exhibitor-panel-head">
              <div>
                <h4>最近导入记录</h4>
                <p>展示最近一次项目表格导入的结果摘要，正式历史会接入导入任务接口。</p>
              </div>
              <button className="ghost-button" type="button" onClick={() => setActivePanel(null)}>收起</button>
            </div>
            <div className="exhibitor-history-list">
              <article>
                <strong>第23届中原农资双交会后勤表.xlsx</strong>
                <span>识别 {booths.length} 个展商 · {assignedCount} 个已关联成员 · {importDiffCount} 条差异待确认</span>
              </article>
              <article>
                <strong>普通绿色搭建汇总 / 标展楣牌</strong>
                <span>系统只保留展位、展商、位置、面积、类型、销售和现场搭建成员。</span>
              </article>
            </div>
          </section>
        )}

        {selectedKeys.size > 0 && (
          <div className="exhibitor-bulk-bar" role="status">
            <strong>已选择 {selectedKeys.size} 个展商</strong>
            {renderAssignmentTrigger("bulk", (
              <button className="secondary-button" type="button" onClick={() => openAssignmentDialog({ mode: "bulk" }, "bulk")}>批量分配搭建成员</button>
            ))}
            <Dialog.Trigger {...batchTypeDialogScope} asChild>
              <button className="secondary-button" type="button" onClick={openBatchTypeDialog}>批量修改类型</button>
            </Dialog.Trigger>
            <AlertDialog.Trigger asChild>
              <button className="danger-button" type="button">批量停用</button>
            </AlertDialog.Trigger>
            <button className="ghost-button" type="button" onClick={() => setSelectedKeys(new Set())}>取消选择</button>
          </div>
        )}

        <div className="exhibitor-table-wrap">
          <table className="exhibitor-table" aria-label="展商数据表格">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    aria-label="选择当前页全部展商"
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => toggleVisible(event.currentTarget.checked)}
                  />
                </th>
                <th scope="col">展位号</th>
                <th scope="col">展商</th>
                <th scope="col">位置</th>
                <th scope="col">面积</th>
                <th scope="col">类型</th>
                <th scope="col">销售</th>
                <th scope="col">现场搭建成员</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredBooths.length === 0 ? (
                <tr>
                  <td className="exhibitor-empty-cell" colSpan={9}>暂无匹配展商数据，请调整筛选或上传项目表格。</td>
                </tr>
              ) : paginatedBooths.map((booth) => {
                const key = boothRecordKey(booth);
                const members = builderMembersOf(booth.builder);
                const hasSameBoothExhibitors = (sameBoothCounts.get(booth.boothNumber.trim()) ?? 0) > 1;
                return (
                  <tr key={key}>
                    <td>
                      <input
                        aria-label={`选择${booth.companyName}`}
                        type="checkbox"
                        checked={selectedKeys.has(key)}
                        onChange={(event) => toggleSelected(key, event.currentTarget.checked)}
                      />
                    </td>
                    <th scope="row">
                      <strong>{booth.boothNumber}</strong>
                    </th>
                    <td>
                      <strong className="exhibitor-company">{booth.companyName}</strong>
                      {booth.companyShortName && <small>{booth.companyShortName}</small>}
                      {hasSameBoothExhibitors && <small className="exhibitor-same-booth">同展位存在其他展商</small>}
                    </td>
                    <td>{displayText(booth.location)}</td>
                    <td><AreaDisplay value={booth.area} /></td>
                    <td><span className="exhibitor-type-pill">{displayText(booth.boothType)}</span></td>
                    <td>{displayText(booth.salesOwner)}</td>
                    <td>
                      {members.length > 0 ? (
                        <div className="exhibitor-members" title={members.map((member) => member.name).join("、")}>
                          {members.map((member) => (
                            <span className="exhibitor-member-avatar" key={`${key}-${member.name}`} aria-label={member.name}>
                              {memberInitialOf(member.name)}
                              <span className="sr-only">{member.name}</span>
                            </span>
                          ))}
                          {renderAssignmentTrigger(`table-member:${key}`, (
                            <button className="exhibitor-member-add" type="button" aria-label={`添加${booth.companyName}搭建成员`} onClick={() => openAssignmentDialog({ mode: "single", booth }, `table-member:${key}`)}>+</button>
                          ))}
                        </div>
                      ) : (
                        renderAssignmentTrigger(`table-empty:${key}`, (
                          <button className="exhibitor-empty-member-button" type="button" aria-label={`分配${booth.companyName}搭建成员`} onClick={() => openAssignmentDialog({ mode: "single", booth }, `table-empty:${key}`)}>+ 分配成员</button>
                        ))
                      )}
                    </td>
                    <td>
                      {booth.enabled === false ? (
                        <button
                          className="table-action"
                          type="button"
                          aria-label={`启用${booth.companyName}`}
                          onClick={() => setBoothEnabled(booth, true)}
                        >
                          启用
                        </button>
                      ) : (
                        renderDetailTrigger(booth, "table")
                      )}
                      {!booth.enabled && <span className="exhibitor-disabled-flag">已停用</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="exhibitor-card-list" role="list" aria-label="展商数据卡片列表">
          {filteredBooths.length === 0 ? (
            <p className="exhibitor-empty-note">暂无匹配展商数据，请调整筛选或上传项目表格。</p>
          ) : paginatedBooths.map((booth) => {
            const key = boothRecordKey(booth);
            const members = builderMembersOf(booth.builder);
            const hasSameBoothExhibitors = (sameBoothCounts.get(booth.boothNumber.trim()) ?? 0) > 1;
            return (
              <article className="exhibitor-card" role="listitem" aria-label={`${booth.companyName} ${booth.boothNumber}`} key={`card-${key}`}>
                <div className="exhibitor-card-head">
                  <div>
                    <strong>{booth.companyName}</strong>
                    <span>展位 {booth.boothNumber}</span>
                  </div>
                  <label className="exhibitor-card-check">
                    <span className="sr-only">选择{booth.companyName}</span>
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(key)}
                      onChange={(event) => toggleSelected(key, event.currentTarget.checked)}
                    />
                  </label>
                </div>
                {booth.companyShortName && <p className="exhibitor-card-short">{booth.companyShortName}</p>}
                {hasSameBoothExhibitors && <p className="exhibitor-same-booth">同展位存在其他展商</p>}
                <dl className="exhibitor-card-grid">
                  <div><dt>位置</dt><dd>{displayText(booth.location)}</dd></div>
                  <div><dt>面积</dt><dd><AreaDisplay value={booth.area} /></dd></div>
                  <div><dt>类型</dt><dd>{displayText(booth.boothType)}</dd></div>
                  <div><dt>销售</dt><dd>{displayText(booth.salesOwner)}</dd></div>
                </dl>
                <div className="exhibitor-card-members">
                  <span>现场搭建成员</span>
                  {members.length > 0 ? (
                    <div className="exhibitor-members" title={members.map((member) => member.name).join("、")}>
                      {members.map((member) => (
                        <span className="exhibitor-member-avatar" key={`card-${key}-${member.name}`} aria-label={member.name}>
                          {memberInitialOf(member.name)}
                          <span className="sr-only">{member.name}</span>
                        </span>
                      ))}
                      {renderAssignmentTrigger(`card-member:${key}`, (
                        <button className="exhibitor-member-add" type="button" aria-label={`添加${booth.companyName}搭建成员`} onClick={() => openAssignmentDialog({ mode: "single", booth }, `card-member:${key}`)}>+</button>
                      ))}
                    </div>
                  ) : (
                    renderAssignmentTrigger(`card-empty:${key}`, (
                      <button className="exhibitor-empty-member-button" type="button" aria-label={`分配${booth.companyName}搭建成员`} onClick={() => openAssignmentDialog({ mode: "single", booth }, `card-empty:${key}`)}>+ 分配成员</button>
                    ))
                  )}
                </div>
                <div className="exhibitor-card-actions">
                  {booth.enabled === false ? (
                    <button
                      className="table-action"
                      type="button"
                      aria-label={`启用${booth.companyName}`}
                      onClick={() => setBoothEnabled(booth, true)}
                    >
                      启用
                    </button>
                  ) : (
                    renderDetailTrigger(booth, "card")
                  )}
                  {!booth.enabled && <span className="exhibitor-disabled-flag">已停用</span>}
                </div>
              </article>
            );
          })}
        </div>
        <footer className="exhibitor-footer">
          <div className="exhibitor-footer-summary">
            <span>
              {filteredBooths.length === 0
                ? "共 0 条"
                : `共 ${filteredBooths.length} 条，显示 ${pageStartIndex + 1}-${pageEndIndex} 条`}
            </span>
            <label className="exhibitor-page-size">
              <span>每页条数</span>
              <select value={pageSize} onChange={handlePageSizeChange} aria-label="每页条数">
                {EXHIBITOR_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
          <nav className="exhibitor-pagination" aria-label="分页">
            <button type="button" aria-label="上一页" onClick={() => goToPage(safeCurrentPage - 1)} disabled={safeCurrentPage === 1}>‹</button>
            {paginationItems.map((item) => item === "ellipsis-left" || item === "ellipsis-right" ? (
              <span className="exhibitor-pagination-ellipsis" aria-hidden="true" key={item}>…</span>
            ) : (
              <button
                type="button"
                className={item === safeCurrentPage ? "active" : undefined}
                aria-current={item === safeCurrentPage ? "page" : undefined}
                onClick={() => goToPage(item)}
                key={item}
              >
                {item}
              </button>
            ))}
            <button type="button" aria-label="下一页" onClick={() => goToPage(safeCurrentPage + 1)} disabled={safeCurrentPage === totalPages}>›</button>
          </nav>
        </footer>
      </div>

      {typeDialogOpen && (
        <Dialog.Portal {...typeDialogScope}>
          <div className="exhibitor-assignment-layer">
            <Dialog.Overlay {...typeDialogScope} className="exhibitor-detail-scrim" />
            <Dialog.Content {...typeDialogScope} className="exhibitor-assignment-dialog exhibitor-type-dialog" aria-label="展商类型设置">
            <div className="exhibitor-panel-head">
              <div>
                <Dialog.Title {...typeDialogScope} asChild>
                  <h4>展商类型设置</h4>
                </Dialog.Title>
                <Dialog.Description {...typeDialogScope} asChild>
                  <p>维护项目内可用类型；接入专用接口后将支持正式排序、停用和重命名。</p>
                </Dialog.Description>
              </div>
              <Dialog.Close {...typeDialogScope} asChild>
                <button className="ghost-button" type="button" aria-label="关闭类型设置">关闭</button>
              </Dialog.Close>
            </div>
            <div className="exhibitor-type-list">
              {managedTypes.map((type, index) => {
                const typeDisplayName = typeNameDrafts[type.id] ?? type.name;
                const boothCount = booths.filter((booth) => booth.boothType === type.name || booth.boothType === typeDisplayName).length;
                return (
                  <article key={type.id} className={!type.enabled ? "disabled" : undefined}>
                    <span>{index + 1}</span>
                    <div className="exhibitor-type-entry">
                      <strong>{typeDisplayName}</strong>
                      <small>{boothCount} 个展商</small>
                      {!type.enabled && <em className="exhibitor-type-status">已停用</em>}
                    </div>
                    <label className="exhibitor-type-inline-input">
                      <span className="sr-only">{type.name}类型名称</span>
                      <input
                        aria-label={`${type.name}类型名称`}
                        value={typeDisplayName}
                        onChange={(event) => updateTypeNameDraft(type.id, event.currentTarget.value)}
                      />
                    </label>
                    <div className="exhibitor-type-actions">
                      <button className="ghost-button" type="button" aria-label={`上移${type.name}`} onClick={() => moveManagedType(type.id, -1)} disabled={index === 0}>上移</button>
                      <button className="ghost-button" type="button" aria-label={`下移${type.name}`} onClick={() => moveManagedType(type.id, 1)} disabled={index === managedTypes.length - 1}>下移</button>
                      <button className="ghost-button" type="button" aria-label={`保存${type.name}类型名称`} onClick={() => saveManagedTypeName(type)} disabled={!typeDisplayName.trim()}>保存</button>
                      <button className="ghost-button" type="button" aria-label={`${type.enabled ? "停用" : "启用"}${type.name}`} onClick={() => setManagedTypeEnabled(type.id, !type.enabled)}>{type.enabled ? "停用" : "启用"}</button>
                    </div>
                  </article>
                );
              })}
              <article className="disabled">
                <span>停</span>
                <div className="exhibitor-type-entry">
                  <strong>已停用类型</strong>
                  <small>保留历史展商类型，不影响已有记录。</small>
                </div>
              </article>
            </div>
            <form className="exhibitor-type-form" onSubmit={addManagedType}>
              <label>
                <span>新增类型名称</span>
                <input aria-label="新增类型名称" value={newTypeName} onChange={(event) => setNewTypeName(event.currentTarget.value)} />
              </label>
              <button className="secondary-button" type="submit">新增类型</button>
            </form>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      )}

      {assignmentDialog && (
        <Dialog.Portal {...assignmentDialogScope}>
          <div className="exhibitor-assignment-layer">
            <Dialog.Overlay {...assignmentDialogScope} className="exhibitor-detail-scrim" />
            <Dialog.Content
              {...assignmentDialogScope}
            className="exhibitor-assignment-dialog exhibitor-member-assignment-dialog"
            aria-label={assignmentDialog.mode === "bulk" ? "批量分配现场搭建成员" : "分配现场搭建成员"}
          >
            <div className="exhibitor-panel-head">
              <div>
                <Dialog.Title {...assignmentDialogScope} asChild>
                  <h4>{assignmentDialog.mode === "bulk" ? "批量分配现场搭建成员" : "分配现场搭建成员"}</h4>
                </Dialog.Title>
                <Dialog.Description {...assignmentDialogScope} asChild>
                  <p>{assignmentDialog.mode === "bulk" ? `已选择 ${selectedBooths.length} 个展商` : assignmentDialog.booth.companyName}</p>
                </Dialog.Description>
              </div>
              <Dialog.Close {...assignmentDialogScope} asChild>
                <button className="ghost-button" type="button" aria-label="关闭成员分配">关闭</button>
              </Dialog.Close>
            </div>
            <div className="exhibitor-assignment-scrollbody" aria-label="批量分配可滚动内容">
              <div className="exhibitor-assignment-targets" aria-label="已选择展商列表">
                {assignmentDialog.mode === "bulk" ? selectedBooths.map((booth) => (
                  <span key={`target-${boothRecordKey(booth)}`}>{booth.boothNumber} · {booth.companyName}</span>
                )) : (
                  <span>{assignmentDialog.booth.boothNumber} · {assignmentDialog.booth.companyName}</span>
                )}
              </div>
              <div className="exhibitor-assignment-candidates" aria-label="可选搭建组成员">
                {availableBuilderMembers.map((name) => (
                  <label key={name}>
                    <input
                      aria-label={name}
                      type="checkbox"
                      checked={assignmentMemberNames.has(name)}
                      onChange={(event) => toggleAssignmentMember(name, event.currentTarget.checked)}
                    />
                    <span className="exhibitor-member-avatar">{memberInitialOf(name)}</span>
                    <strong>{name}</strong>
                  </label>
                ))}
              </div>
            </div>
            <div className="exhibitor-detail-actions exhibitor-assignment-sticky-actions" role="group" aria-label="成员分配操作">
              <Dialog.Close {...assignmentDialogScope} asChild>
                <button className="secondary-button" type="button" aria-label="取消成员分配">取消</button>
              </Dialog.Close>
              <button className="secondary-button" type="button" onClick={saveAssignment}>确认分配</button>
            </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      )}

      {diffDialogOpen && (
        <Dialog.Portal {...diffDialogScope}>
          <div className="exhibitor-assignment-layer">
            <Dialog.Overlay {...diffDialogScope} className="exhibitor-detail-scrim" />
            <Dialog.Content {...diffDialogScope} className="exhibitor-assignment-dialog exhibitor-diff-dialog" aria-label="导入差异数值确认">
            <div className="exhibitor-panel-head">
              <div>
                <Dialog.Title {...diffDialogScope} asChild>
                  <h4>导入差异数值确认</h4>
                </Dialog.Title>
                <Dialog.Description {...diffDialogScope} asChild>
                  <p>这些记录缺少看板必需字段，先在这里补齐；点击应用后只更新当前看板字段。</p>
                </Dialog.Description>
              </div>
              <Dialog.Close {...diffDialogScope} asChild>
                <button className="ghost-button" type="button" aria-label="关闭导入差异数值确认">关闭</button>
              </Dialog.Close>
            </div>
            <div className="exhibitor-diff-guides" aria-label="导入差异处理说明">
              <article>
                <strong>填写建议</strong>
                <p>位置填展馆/楼层，例如“一楼 / 1A”；面积只填数字或规格，例如“18”或“3×3m”；类型选项目内名称，例如“普通绿搭”。</p>
              </article>
              <article>
                <strong>应用后结果</strong>
                <p>补齐展位、展商、位置、面积、类型后，这条记录会从“待确认导入差异”中移出。</p>
              </article>
            </div>
            {importDiffRows.length > 0 ? (
              <div className="exhibitor-diff-editor-list">
                {importDiffRows.map(({ booth, key, draft }) => (
                  <article className="exhibitor-diff-editor-card" key={`diff-editor-${key}`}>
                    <div className="exhibitor-diff-editor-head">
                      <div>
                        <strong>{displayText(draft.companyName || booth.companyName)}</strong>
                        <span>{displayText(draft.boothNumber || booth.boothNumber)}</span>
                      </div>
                      <div className="exhibitor-diff-tags" aria-label={`${booth.companyName || booth.boothNumber}缺失字段`}>
                        {!booth.boothNumber?.trim() && <b>缺失展位号</b>}
                        {!booth.companyName?.trim() && <b>缺失展商</b>}
                        {!booth.location?.trim() && <b>缺失位置</b>}
                        {!booth.area?.trim() && <b>缺失面积</b>}
                        {!booth.boothType?.trim() && <b>缺失类型</b>}
                      </div>
                    </div>
                    <div className="exhibitor-diff-editor-grid">
                      {[
                        ["boothNumber", "展位号"],
                        ["companyName", "展商"],
                        ["location", "位置"],
                        ["area", "面积"],
                        ["boothType", "类型"]
                      ].map(([field, label]) => (
                        <label key={`${key}-${field}`}>
                          <span>{label}</span>
                          <input
                            aria-label={`${displayText(booth.companyName || booth.boothNumber)}${label}`}
                            value={draft[field as keyof BoothDiffDraft]}
                            onChange={(event) => updateDiffDraft(key, field as keyof BoothDiffDraft, event.currentTarget.value)}
                          />
                        </label>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="exhibitor-empty-note">当前没有待确认导入差异。</p>
            )}
            <div className="exhibitor-detail-actions">
              <Dialog.Close {...diffDialogScope} asChild>
                <button className="secondary-button" type="button">取消</button>
              </Dialog.Close>
              <button className="secondary-button" type="button" onClick={applyDiffRows} disabled={!allDiffDraftsComplete}>应用到看板并移出待确认</button>
            </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      )}

      {activeBooth && (
          <Dialog.Portal>
            <div className="exhibitor-detail-layer">
              <Dialog.Overlay className="exhibitor-detail-scrim" />
              <Dialog.Content className="exhibitor-detail-drawer" aria-label="展商详情">
            <Dialog.Title className="sr-only">展商详情</Dialog.Title>
            <div className="exhibitor-detail-head">
              <div>
                <span>{displayText(activeBooth.boothType)}</span>
                <h4>{activeBooth.companyName}</h4>
                <Dialog.Description asChild>
                  <p>展位 {activeBooth.boothNumber}</p>
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button className="ghost-button" type="button" aria-label="关闭详情">关闭</button>
              </Dialog.Close>
            </div>
            <section className="exhibitor-detail-section">
              <h5>展商基础数据</h5>
              <dl>
                <div><dt>展位号</dt><dd>{activeBooth.boothNumber}</dd></div>
                <div><dt>展商名称</dt><dd>{activeBooth.companyName}</dd></div>
                <div><dt>位置</dt><dd>{displayText(activeBooth.location)}</dd></div>
                <div><dt>面积</dt><dd>{areaDisplayParts(activeBooth.area).primary}</dd></div>
                <div><dt>面积规格</dt><dd>{areaDisplayParts(activeBooth.area).spec}</dd></div>
                <div><dt>类型</dt><dd>{displayText(activeBooth.boothType)}</dd></div>
                <div><dt>销售</dt><dd>{displayText(activeBooth.salesOwner)}</dd></div>
              </dl>
            </section>
            <section className="exhibitor-detail-section">
              <h5>现场搭建成员</h5>
              {activeMembers.length > 0 ? (
                <div className="exhibitor-detail-members">
                  {activeMembers.map((member) => (
                    <span key={`${activeBooth.boothNumber}-${member.name}`}>
                      <i className="exhibitor-member-avatar" aria-hidden="true">{memberInitialOf(member.name)}</i>
                      <strong>{member.name}</strong>
                      {member.phone && <small>{maskedPhone(member.phone)}</small>}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="exhibitor-empty-note">暂未分配现场搭建成员。</p>
              )}
              {renderAssignmentTrigger(`drawer-add:${boothRecordKey(activeBooth)}`, (
                <button className="secondary-button" type="button" aria-label="添加现场搭建成员" onClick={() => openAssignmentDialog({ mode: "single", booth: activeBooth }, `drawer-add:${boothRecordKey(activeBooth)}`)}>+ 添加现场搭建成员</button>
              ))}
            </section>
            <div className="exhibitor-detail-actions">
              <Dialog.Close asChild>
                <button className="secondary-button" type="button">取消</button>
              </Dialog.Close>
              <Dialog.Trigger {...editDialogScope} asChild>
                <button className="primary-button" type="button" onClick={() => openEditDialog(activeBooth)}>编辑展商数据</button>
              </Dialog.Trigger>
              {renderAssignmentTrigger(`drawer-footer:${boothRecordKey(activeBooth)}`, (
                <button className="secondary-button" type="button" onClick={() => openAssignmentDialog({ mode: "single", booth: activeBooth }, `drawer-footer:${boothRecordKey(activeBooth)}`)}>分配搭建成员</button>
              ))}
              <button
                className="secondary-button"
                type="button"
                onClick={() => setBoothEnabled(activeBooth, activeBooth.enabled === false)}
              >
                {activeBooth.enabled === false ? `启用${activeBooth.companyName}` : "停用展商"}
              </button>
            </div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
      )}

      {importWizardOpen && (
        <ExhibitorImportWizard
          isImporting={isImporting}
          onClose={() => setImportWizardOpen(false)}
          onImportFile={onImportFile}
        />
      )}

      {editingBooth && (
        <Dialog.Portal {...editDialogScope}>
          <div className="exhibitor-assignment-layer">
            <Dialog.Overlay {...editDialogScope} className="exhibitor-detail-scrim" />
            <Dialog.Content {...editDialogScope} className="exhibitor-assignment-dialog" aria-label="编辑展商数据">
            <div className="exhibitor-panel-head">
              <div>
                <Dialog.Title {...editDialogScope} asChild>
                  <h4>编辑展商数据</h4>
                </Dialog.Title>
                <Dialog.Description {...editDialogScope} asChild>
                  <p>只保留展位号、展商、位置、面积、面积规格、类型、销售七项基础数据。</p>
                </Dialog.Description>
              </div>
              <Dialog.Close {...editDialogScope} asChild>
                <button className="ghost-button" type="button" aria-label="关闭编辑展商数据">关闭</button>
              </Dialog.Close>
            </div>
            <div className="exhibitor-edit-form">
              {[
                ["boothNumber", "展位号"],
                ["companyName", "展商"],
                ["location", "位置"],
                ["area", "面积"],
                ["areaSpecification", "面积规格"],
                ["boothType", "类型"],
                ["salesOwner", "销售"]
              ].map(([field, label]) => (
                <label key={field}>
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    value={editingBooth.draft[field as keyof BoothEditorDraft]}
                    onChange={(event) => updateEditDraft(field as keyof BoothEditorDraft, event.currentTarget.value)}
                  />
                </label>
              ))}
            </div>
            <div className="exhibitor-detail-actions">
              <Dialog.Close {...editDialogScope} asChild>
                <button className="secondary-button" type="button">取消</button>
              </Dialog.Close>
              <button className="secondary-button" type="button" onClick={saveEditedBooth}>保存展商数据</button>
            </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      )}

      {batchTypeDialogOpen && (
        <Dialog.Portal {...batchTypeDialogScope}>
          <div className="exhibitor-assignment-layer">
            <Dialog.Overlay {...batchTypeDialogScope} className="exhibitor-detail-scrim" />
            <Dialog.Content {...batchTypeDialogScope} className="exhibitor-assignment-dialog" aria-label="批量修改类型">
            <div className="exhibitor-panel-head">
              <div>
                <Dialog.Title {...batchTypeDialogScope} asChild>
                  <h4>批量修改类型</h4>
                </Dialog.Title>
                <Dialog.Description {...batchTypeDialogScope} asChild>
                  <p>为已选展商统一修改展商类型。</p>
                </Dialog.Description>
              </div>
              <Dialog.Close {...batchTypeDialogScope} asChild>
                <button className="ghost-button" type="button" aria-label="关闭批量修改类型">关闭</button>
              </Dialog.Close>
            </div>
            <label className="exhibitor-type-form">
              <span>目标类型</span>
              <select aria-label="目标类型" value={batchTypeName} onChange={(event) => setBatchTypeName(event.currentTarget.value)}>
                {typeOptions.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
            <div className="exhibitor-detail-actions">
              <Dialog.Close {...batchTypeDialogScope} asChild>
                <button className="secondary-button" type="button">取消</button>
              </Dialog.Close>
              <button className="secondary-button" type="button" onClick={saveBatchType}>确认修改类型</button>
            </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      )}

      {batchDisableDialogOpen && (
        <AlertDialog.Portal>
          <div className="exhibitor-assignment-layer">
            <AlertDialog.Overlay className="exhibitor-detail-scrim" />
            <AlertDialog.Content className="exhibitor-assignment-dialog" aria-label="批量停用展商">
            <div className="exhibitor-panel-head">
              <div>
                <AlertDialog.Title asChild>
                  <h4>批量停用展商</h4>
                </AlertDialog.Title>
                <AlertDialog.Description asChild>
                  <p>已选择 {selectedKeys.size} 个展商，停用后将从默认可用列表中移出。</p>
                </AlertDialog.Description>
              </div>
              <button className="ghost-button" type="button" aria-label="关闭批量停用展商" onClick={() => setBatchDisableDialogOpen(false)}>关闭</button>
            </div>
            <div className="exhibitor-detail-actions">
              <AlertDialog.Cancel asChild>
                <button className="secondary-button" type="button">取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="danger-button" type="button" onClick={batchDisableSelectedBooths}>确认停用展商</button>
              </AlertDialog.Action>
            </div>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      )}
                  </section>
                </AlertDialog.Root>
              </Dialog.Root>
            </Dialog.Root>
          </Dialog.Root>
        </Dialog.Root>
      </Dialog.Root>
    </Dialog.Root>
  );
}
