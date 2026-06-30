"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type TouchEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Hand,
  ImagePlus,
  Maximize2,
  MessageSquareReply,
  RotateCcw,
  RotateCw,
  Send,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { createPortal } from "react-dom";
import type { CurrentUser } from "@/lib/client/auth";
import { readImagesAsDataUrls } from "@/lib/client/images";
import { apiFetch, isUnauthorized } from "@/lib/client/api-request";
import { queryKeys } from "@/lib/client/query-keys";
import { formatDisplayDateTime, formatDisplayTime } from "@/lib/domain/time-format";
import type { Ticket, TicketStatus } from "@/lib/domain/types";
import { PriorityBadge } from "./priority-badge";
import { StatusMessage } from "./status-message";
import { StatusPill } from "./status-pill";

const BASE_WORKFLOW_STEPS: TicketStatus[] = ["待受理", "处理中", "已解决", "已关闭"];
const GALLERY_MIN_ZOOM = 1;
const GALLERY_MAX_ZOOM = 3;
const GALLERY_ZOOM_STEP = 0.5;

function ticketHasStep(ticket: Ticket, step: TicketStatus) {
  if (ticket.status === step) return true;
  return ticket.timeline.some((item) => {
    if (step === "待再次处理") return item.body.includes("待再次处理") || item.body.includes("验收未通过");
    return item.body.includes(step);
  });
}

function visibleWorkflowSteps(ticket: Ticket): TicketStatus[] {
  const steps: TicketStatus[] = [...BASE_WORKFLOW_STEPS];
  if (ticketHasStep(ticket, "挂起")) steps.splice(2, 0, "挂起");
  if (ticketHasStep(ticket, "待再次处理")) steps.splice(steps.indexOf("已解决"), 0, "待再次处理");
  return steps;
}

function TicketProgress({ ticket }: { ticket: Ticket }) {
  const steps = visibleWorkflowSteps(ticket);
  const currentIndex = Math.max(steps.indexOf(ticket.status), 0);
  const urgeSummary = ticket.lastUrgedAt
    ? `催单 ${ticket.urgeCount}次 · 最近 ${formatDisplayTime(ticket.lastUrgedAt)}`
    : `催单 ${ticket.urgeCount}次`;

  return (
    <section className="progress-card" aria-label="工单处理进度">
      <div className="progress-summary">
        <span>当前进度</span>
        <strong className="progress-urge">{urgeSummary}</strong>
      </div>
      <ol className="progress-steps" aria-label="进度节点" data-progress-count={steps.length} style={{ "--progress-count": steps.length } as CSSProperties}>
        {steps.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
          return (
            <li className={`progress-step ${state}`} key={step} aria-current={state === "current" ? "step" : undefined}>
              <span className="progress-dot">{index + 1}</span>
              <span className="progress-label">{step}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function nextStatuses(status: TicketStatus): TicketStatus[] {
  if (status === "处理中") return ["已解决", "挂起"];
  if (status === "挂起") return ["处理中"];
  if (status === "待再次处理") return ["已解决", "挂起"];
  return [];
}

function contactText(name: string, phone?: string) {
  return phone ? `${name} · ${phone}` : name;
}

function PersonValue({ name, phone }: { name: string; phone?: string }) {
  return <strong className="person-line">{contactText(name, phone)}</strong>;
}

type ImageGallery = {
  title: string;
  images: string[];
  index: number;
  rotations: number[];
  zoom: number;
};

function clampGalleryZoom(zoom: number) {
  return Math.min(GALLERY_MAX_ZOOM, Math.max(GALLERY_MIN_ZOOM, Number(zoom.toFixed(2))));
}

function GalleryImageGrid({
  ariaLabel,
  altPrefix,
  compact = true,
  images,
  onOpen,
  title
}: {
  ariaLabel?: string;
  altPrefix: string;
  compact?: boolean;
  images: string[];
  onOpen: (title: string, images: string[], index: number, opener: HTMLButtonElement) => void;
  title: string;
}) {
  return (
    <div className={`image-preview-grid${compact ? " image-preview-grid-compact" : ""}`} aria-label={ariaLabel}>
      {images.map((url, index) => (
        <button
          aria-label={`查看${altPrefix} ${index + 1}`}
          className="gallery-image-button"
          key={`${url}-${index}`}
          onClick={(event) => onOpen(title, images, index, event.currentTarget)}
          type="button"
        >
          <img alt={`${altPrefix} ${index + 1}`} src={url} />
        </button>
      ))}
    </div>
  );
}

export function TicketDetail({
  currentUser,
  onUnauthorized,
  ticket
}: {
  ticket?: Ticket;
  currentUser?: CurrentUser;
  onUnauthorized?: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [replyImageUrls, setReplyImageUrls] = useState<string[]>([]);
  const [processImageUrls, setProcessImageUrls] = useState<string[]>([]);
  const [gallery, setGallery] = useState<ImageGallery | null>(null);
  const touchStartX = useRef<number | null>(null);
  const galleryDialogRef = useRef<HTMLDivElement | null>(null);
  const galleryCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const galleryOpenerRef = useRef<HTMLButtonElement | null>(null);
  const galleryStageRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const patchMutation = useMutation({
    mutationFn: (variables: { ticketId: string; payload: Record<string, unknown> }) => apiFetch(
      `/api/tickets/${variables.ticketId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(variables.payload)
      },
      "工单操作失败，请稍后重试"
    )
  });
  const replyMutation = useMutation({
    mutationFn: (variables: { ticketId: string; body: string; imageUrls: string[] }) => apiFetch(
      `/api/tickets/${variables.ticketId}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: variables.body, imageUrls: variables.imageUrls })
      },
      "回复失败，请稍后重试"
    )
  });
  const isGalleryOpen = Boolean(gallery);
  const activeGalleryRotation = gallery ? gallery.rotations[gallery.index] ?? 0 : 0;

  useEffect(() => {
    setReplyImageUrls([]);
    setProcessImageUrls([]);
    setMessage(null);
    setGallery(null);
  }, [ticket?.id]);

  useEffect(() => {
    if (!isGalleryOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    galleryCloseButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGallery();
      }
      if (event.key === "ArrowLeft") moveGallery(-1);
      if (event.key === "ArrowRight") moveGallery(1);
      if (event.key !== "Tab") return;
      const focusableElements = Array.from(
        galleryDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusableElements.length === 0) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      galleryOpenerRef.current?.focus();
    };
  }, [isGalleryOpen]);

  useEffect(() => {
    if (!gallery) return;
    const stage = galleryStageRef.current;
    if (!stage) return;
    const centerStage = () => {
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
    };
    if (typeof window.requestAnimationFrame !== "function") {
      centerStage();
      return;
    }
    const frame = window.requestAnimationFrame(centerStage);
    return () => window.cancelAnimationFrame?.(frame);
  }, [gallery?.index, gallery?.zoom, activeGalleryRotation]);

  function openGallery(title: string, images: string[], index: number, opener: HTMLButtonElement) {
    if (!images.length) return;
    galleryOpenerRef.current = opener;
    setGallery({ title, images, index, rotations: images.map(() => 0), zoom: GALLERY_MIN_ZOOM });
  }

  function closeGallery() {
    setGallery(null);
  }

  function moveGallery(direction: -1 | 1) {
    setGallery((current) => {
      if (!current || current.images.length < 2) return current;
      return {
        ...current,
        index: (current.index + direction + current.images.length) % current.images.length,
        zoom: GALLERY_MIN_ZOOM
      };
    });
  }

  function changeGalleryZoom(direction: -1 | 1) {
    setGallery((current) => {
      if (!current) return current;
      return { ...current, zoom: clampGalleryZoom(current.zoom + direction * GALLERY_ZOOM_STEP) };
    });
  }

  function resetGalleryZoom() {
    setGallery((current) => (current ? { ...current, zoom: GALLERY_MIN_ZOOM } : current));
  }

  function rotateGallery(direction: -1 | 1) {
    setGallery((current) => {
      if (!current) return current;
      const rotations = [...current.rotations];
      rotations[current.index] = ((rotations[current.index] ?? 0) + direction * 90 + 360) % 360;
      return { ...current, rotations };
    });
  }

  function handleGalleryTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (gallery && gallery.zoom > GALLERY_MIN_ZOOM) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleGalleryTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (gallery && gallery.zoom > GALLERY_MIN_ZOOM) {
      touchStartX.current = null;
      return;
    }
    if (touchStartX.current === null) return;
    const touchEndX = event.changedTouches[0]?.clientX ?? touchStartX.current;
    const distance = touchEndX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(distance) < 40) return;
    moveGallery(distance < 0 ? 1 : -1);
  }

  async function addReplyImages(files: FileList | null) {
    if (!files?.length) return;
    try {
      const nextImages = await readImagesAsDataUrls(files);
      setReplyImageUrls((current) => [...current, ...nextImages]);
      setMessage(null);
    } catch {
      setMessage("图片读取失败，请重新选择");
    }
  }

  async function addProcessImages(files: FileList | null) {
    if (!files?.length) return;
    try {
      const nextImages = await readImagesAsDataUrls(files);
      setProcessImageUrls((current) => [...current, ...nextImages]);
      setMessage(null);
    } catch {
      setMessage("处理照片读取失败，请重新选择");
    }
  }

  if (!ticket) return <section className="empty-state">选择一个工单查看处理详情</section>;
  const currentTicket = ticket;
  const galleryZoomPercent = gallery ? `${Math.round(gallery.zoom * 100)}%` : "100%";
  const gallerySurfaceStyle = { width: galleryZoomPercent, height: galleryZoomPercent } as CSSProperties;
  const processOptions = nextStatuses(ticket.status);
  const canClaim = Boolean(currentUser?.permissions?.canClaim && ticket.status === "待受理" && (!ticket.handlerId || ticket.assignmentGroup === currentUser.groupName));
  const canProcess = Boolean(
    currentUser?.permissions?.canProcess &&
    processOptions.length > 0 &&
    (ticket.handlerId === currentUser.id || ticket.assignmentGroup === currentUser.groupName)
  );
  const canAccept = Boolean(currentUser?.permissions?.canAccept && ticket.status === "已解决");

  async function patchTicket(payload: Record<string, unknown>) {
    setMessage(null);
    try {
      await patchMutation.mutateAsync({ ticketId: currentTicket.id, payload });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobile.bootstrap }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobile.ticket(currentTicket.id) })
      ]);
      setProcessImageUrls([]);
      return true;
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized?.();
        return false;
      }
      setMessage("工单操作失败，请稍后重试");
      return false;
    }
  }

  async function claimTicket() {
    if (!currentUser) return;
    await patchTicket({
      action: "claim",
      status: "处理中"
    });
  }

  async function submitProgress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentUser) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const processBody = String(formData.get("processBody") ?? "").trim();
    if (!processBody || processImageUrls.length === 0) {
      setMessage("请填写处理内容并上传处理照片");
      return;
    }
    const succeeded = await patchTicket({
      action: "progress",
      status: String(formData.get("nextStatus") ?? processOptions[0]),
      processBody,
      imageUrls: processImageUrls
    });
    if (succeeded) form.reset();
  }

  async function acceptTicket() {
    if (!currentUser) return;
    await patchTicket({
      action: "accept",
      status: "已关闭"
    });
  }

  async function rejectTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentUser) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const reason = String(formData.get("rejectReason") ?? "").trim();
    if (!reason) {
      setMessage("请填写未通过原因");
      return;
    }
    const succeeded = await patchTicket({
      action: "reject",
      status: "待再次处理",
      reason
    });
    if (succeeded) form.reset();
  }

  async function addReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setMessage(null);
    const formData = new FormData(form);
    try {
      await replyMutation.mutateAsync({
        ticketId: currentTicket.id,
        body: String(formData.get("body") ?? ""),
        imageUrls: replyImageUrls
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobile.bootstrap }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobile.ticket(currentTicket.id) })
      ]);
      form.reset();
      setReplyImageUrls([]);
      setMessage("回复已追加");
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized?.();
        return;
      }
      setMessage("回复失败，请稍后重试");
    }
  }

  return (
    <article className="detail-panel detail-panel-compact">
      <h1 className="sr-only">工单详情</h1>
      <div className="detail-head detail-head-compact">
        <div className="detail-title-block">
          <h2>{ticket.title}</h2>
          <p className="detail-company">{ticket.companyName}</p>
        </div>
        <div className="detail-badge-stack">
          <StatusPill status={ticket.status} />
          <PriorityBadge score={ticket.priorityScore} />
        </div>
      </div>

      <TicketProgress ticket={ticket} />

      <dl className="fact-grid detail-time-grid detail-time-grid-single-line" aria-label="工单时间信息">
        <div><dt>提交时间</dt><dd>{formatDisplayDateTime(ticket.createdAt)}</dd></div>
        <div><dt>受理时间</dt><dd>{ticket.acceptedAt ? formatDisplayDateTime(ticket.acceptedAt) : "未受理"}</dd></div>
        <div><dt>更新时间</dt><dd>{formatDisplayDateTime(ticket.updatedAt)}</dd></div>
      </dl>

      {(canClaim || canProcess || canAccept) && (
        <section className="action-panel" aria-label="工单操作">
          {canClaim && (
            <button className="primary-button" type="button" onClick={() => void claimTicket()} disabled={patchMutation.isPending}>
              <Hand size={17} aria-hidden="true" />认领工单
            </button>
          )}
          {canProcess && (
            <form className="process-form" onSubmit={submitProgress}>
              <label>
                <span>下一进度</span>
                <select name="nextStatus" defaultValue={processOptions[0]}>
                  {processOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </label>
              <label>
                <span>处理内容</span>
                <textarea name="processBody" placeholder="说明处理动作、现场结果和后续风险" required />
              </label>
              <label className="image-upload">
                <span>处理照片</span>
                <input accept="image/*" multiple type="file" onChange={(event) => void addProcessImages(event.target.files)} />
              </label>
              {processImageUrls.length > 0 && (
                <GalleryImageGrid
                  altPrefix="处理照片"
                  ariaLabel="已选择处理照片"
                  images={processImageUrls}
                  onOpen={openGallery}
                  title="处理照片"
                />
              )}
              <p className="image-hint"><Camera size={16} aria-hidden="true" />已选择 {processImageUrls.length} 张处理照片</p>
              <button className="primary-button" type="submit" disabled={patchMutation.isPending}><Send size={17} aria-hidden="true" />提交处理进度</button>
            </form>
          )}
          {canAccept && (
            <>
              <button className="primary-button accept-button" type="button" onClick={() => void acceptTicket()} disabled={patchMutation.isPending}>
                <CheckCircle2 size={17} aria-hidden="true" />验收通过
              </button>
              <form className="reject-form" onSubmit={rejectTicket}>
                <label>
                  <span>未通过原因</span>
                  <textarea name="rejectReason" placeholder="说明未通过原因，便于处理组再次整改" required />
                </label>
                <button className="secondary-button reject-button" type="submit" disabled={patchMutation.isPending}>验收未通过</button>
              </form>
            </>
          )}
        </section>
      )}

      <section className="detail-description-card" aria-label="问题描述">
        <span>问题描述</span>
        <p>{ticket.description}</p>
      </section>

      <section className="people-panel people-panel-modern compact-section" aria-label="相关人员">
        <div className="people-panel-head">
          <h3>相关人员</h3>
        </div>
        <div className="people-core-grid">
          <article className="person-card">
            <span>提交人</span>
            <PersonValue name={ticket.submitterName} phone={ticket.submitterPhone} />
          </article>
          <article className="person-card">
            <span>处理人</span>
            <PersonValue name={ticket.handlerName ?? "待派单"} phone={ticket.handlerPhone} />
          </article>
        </div>
        <div className="person-group-row">
          <span>处理组</span>
          <strong>{ticket.assignmentGroup ?? "待认领"}</strong>
        </div>
        <div className="feedback-list">
          <div className="feedback-list-head">
            <span>反馈用户 {ticket.feedbackUsers.length}人</span>
            <small>最近反馈</small>
          </div>
          {ticket.feedbackUsers.map((user, index) => (
            <div className="feedback-person-row" key={user.userId}>
              <em>{index + 1}</em>
              <strong>{contactText(user.userName, user.phone)}</strong>
              <time dateTime={user.feedbackAt}>{formatDisplayTime(user.feedbackAt)}</time>
            </div>
          ))}
        </div>
      </section>

      {ticket.imageUrls.length > 0 && (
        <section className="image-section compact-section" aria-label="工单图片">
          <h3>工单图片</h3>
          <GalleryImageGrid altPrefix="工单图片" images={ticket.imageUrls} onOpen={openGallery} title="工单图片" />
        </section>
      )}

      <section className="timeline compact-section" aria-label="处理记录">
        {ticket.timeline.map((item) => (
          <div key={item.id} className="timeline-item">
            <span className="timeline-meta">
              <em>{item.actorName}</em>
              <time dateTime={item.createdAt}>{formatDisplayTime(item.createdAt)}</time>
            </span>
            <p>{item.body}</p>
          </div>
        ))}
      </section>

      {ticket.replies.length > 0 && (
        <section className="reply-thread compact-section" aria-label="回复与处理记录">
          <h3>回复与处理记录</h3>
          {ticket.replies.map((reply) => (
            <article className={`reply-card reply-card-${reply.role}`} key={reply.id}>
              <div className="reply-card-head">
                <strong>{reply.authorName}</strong>
                {reply.authorPhone && <small>{reply.authorPhone}</small>}
                <span>{reply.role === "handler" ? "处理反馈" : "现场回复"}</span>
                <time dateTime={reply.createdAt}>{formatDisplayTime(reply.createdAt)}</time>
              </div>
              <p>{reply.body}</p>
              {reply.imageUrls.length > 0 && (
                <GalleryImageGrid
                  altPrefix={reply.role === "handler" ? "处理记录图片" : "回复图片"}
                  images={reply.imageUrls}
                  onOpen={openGallery}
                  title={reply.role === "handler" ? "处理记录图片" : "回复图片"}
                />
              )}
            </article>
          ))}
        </section>
      )}

      <form className="reply-box" onSubmit={addReply}>
        <label>
          <span>回复内容</span>
          <textarea name="body" placeholder="追加现场信息或处理回复" required />
        </label>
        <label className="image-upload">
          <span>回复图片</span>
          <input accept="image/*" multiple type="file" onChange={(event) => void addReplyImages(event.target.files)} />
        </label>
        {replyImageUrls.length > 0 && (
          <GalleryImageGrid
            altPrefix="回复图片"
            ariaLabel="已选择回复图片"
            compact={false}
            images={replyImageUrls}
            onOpen={openGallery}
            title="回复图片"
          />
        )}
        <p className="image-hint"><ImagePlus size={16} aria-hidden="true" />已选择 {replyImageUrls.length} 张图片</p>
        {message && <StatusMessage tone={message === "回复已追加" ? "status" : "error"}>{message}</StatusMessage>}
        <button type="submit" disabled={replyMutation.isPending}>
          <MessageSquareReply size={18} aria-hidden="true" />
          {replyMutation.isPending ? "回复中" : "回复"}
        </button>
      </form>

      {gallery && typeof document !== "undefined" && createPortal(
        <div aria-label="图片预览" aria-modal="true" className="image-viewer-backdrop" onClick={closeGallery} ref={galleryDialogRef} role="dialog">
          <div className="image-viewer-panel" onClick={(event) => event.stopPropagation()}>
            <header className="image-viewer-head">
              <div>
                <strong>{gallery.title}</strong>
                <span>左右滑动浏览，可旋转查看，点击空白关闭</span>
              </div>
              <span className="image-viewer-counter">{gallery.index + 1} / {gallery.images.length}</span>
              <button aria-label="关闭图片预览" className="image-viewer-close" onClick={closeGallery} ref={galleryCloseButtonRef} type="button">
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="image-viewer-body">
              <button
                aria-label="上一张"
                className="image-viewer-nav image-viewer-nav-prev"
                disabled={gallery.images.length < 2}
                onClick={() => moveGallery(-1)}
                type="button"
              >
                <ChevronLeft size={24} aria-hidden="true" />
              </button>
              <div
                aria-label="图片滑动区域"
                className="image-viewer-stage"
                data-zoomed={gallery.zoom > GALLERY_MIN_ZOOM ? "true" : "false"}
                onTouchEnd={handleGalleryTouchEnd}
                onTouchStart={handleGalleryTouchStart}
                ref={galleryStageRef}
              >
                <div className="image-viewer-zoom-surface" data-testid="image-viewer-zoom-surface" style={gallerySurfaceStyle}>
                  <img
                    alt={`${gallery.title}预览 ${gallery.index + 1}`}
                    src={gallery.images[gallery.index]}
                    style={{ transform: `rotate(${gallery.rotations[gallery.index] ?? 0}deg)` }}
                  />
                </div>
              </div>
              <button
                aria-label="下一张"
                className="image-viewer-nav image-viewer-nav-next"
                disabled={gallery.images.length < 2}
                onClick={() => moveGallery(1)}
                type="button"
              >
                <ChevronRight size={24} aria-hidden="true" />
              </button>
            </div>
            <div className="image-viewer-tools" aria-label="图片查看工具">
              <button
                aria-label="缩小图片"
                className="image-viewer-tool-button"
                disabled={gallery.zoom <= GALLERY_MIN_ZOOM}
                onClick={() => changeGalleryZoom(-1)}
                title="缩小图片"
                type="button"
              >
                <ZoomOut size={17} aria-hidden="true" />
                <span>缩小</span>
              </button>
              <button aria-label="适应全图" className="image-viewer-tool-button" onClick={resetGalleryZoom} title="适应全图" type="button">
                <Maximize2 size={17} aria-hidden="true" />
                <span>{galleryZoomPercent}</span>
              </button>
              <button
                aria-label="放大图片"
                className="image-viewer-tool-button"
                disabled={gallery.zoom >= GALLERY_MAX_ZOOM}
                onClick={() => changeGalleryZoom(1)}
                title="放大图片"
                type="button"
              >
                <ZoomIn size={17} aria-hidden="true" />
                <span>放大</span>
              </button>
              <button className="image-viewer-tool-button" onClick={() => rotateGallery(-1)} title="左转" type="button">
                <RotateCcw size={17} aria-hidden="true" />
                <span>左转</span>
              </button>
              <button className="image-viewer-tool-button" onClick={() => rotateGallery(1)} title="右转" type="button">
                <RotateCw size={17} aria-hidden="true" />
                <span>右转</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </article>
  );
}
