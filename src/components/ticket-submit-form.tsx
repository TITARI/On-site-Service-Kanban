"use client";

import { useState } from "react";
import { ImagePlus, Send } from "lucide-react";
import { readImagesAsDataUrls } from "@/lib/client/images";
import type { CurrentUser } from "@/lib/client/auth";
import type { AppConfig } from "@/lib/seed";
import { StatusMessage } from "./status-message";

type Props = {
  config: AppConfig;
  currentUser: CurrentUser;
  onUnauthorized?: () => void;
  onSubmitted: () => void;
};

export function TicketSubmitForm({ config, currentUser, onSubmitted, onUnauthorized }: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    try {
      const nextImages = await readImagesAsDataUrls(files);
      setImageUrls((current) => [...current, ...nextImages]);
      setMessage(null);
    } catch {
      setMessage("图片读取失败，请重新选择");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setIsSubmitting(true);
    setMessage(null);
    const formData = new FormData(form);
    const payload = {
      boothNumber: String(formData.get("boothNumber") ?? ""),
      description: String(formData.get("description") ?? ""),
      issueType: String(formData.get("issueType") ?? "自动"),
      imageUrls
    };

    try {
      const response = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (response.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (!response.ok) throw new Error("submit failed");
      form.reset();
      setImageUrls([]);
      setMessage("工单已提交");
      setIsSubmitting(false);
      onSubmitted();
    } catch {
      setMessage("提交失败，请检查展位号和问题描述后重试");
      setIsSubmitting(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      <div className="submitter-card" aria-label="当前反馈人">
        <span>反馈人</span>
        <strong>{currentUser.name}</strong>
        {currentUser.phone && <small>{currentUser.phone}</small>}
      </div>
      <label>
        <span>展位号</span>
        <input name="boothNumber" placeholder="例如 A01" required />
      </label>
      <label>
        <span>问题类型</span>
        <select name="issueType" defaultValue="自动">
          <option value="自动">自动</option>
          {config.issueTypes.filter((item) => item.enabled).map((item) => (
            <option key={item.id} value={item.name}>{item.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>问题描述</span>
        <textarea name="description" rows={5} placeholder="描述现场情况、影响范围和已尝试处理方式" required />
      </label>
      <label className="image-upload">
        <span>问题图片</span>
        <input accept="image/*" multiple type="file" onChange={(event) => void addImages(event.target.files)} />
      </label>
      {imageUrls.length > 0 && (
        <div className="image-preview-grid" aria-label="已选择图片">
          {imageUrls.map((url, index) => (
            <img alt={`问题图片 ${index + 1}`} key={`${url}-${index}`} src={url} />
          ))}
        </div>
      )}
      <p className="image-hint"><ImagePlus size={16} aria-hidden="true" />已选择 {imageUrls.length} 张图片</p>
      {message && <StatusMessage tone={message === "工单已提交" ? "status" : "error"}>{message}</StatusMessage>}
      <button className="primary-button" type="submit" disabled={isSubmitting}>
        <Send size={18} aria-hidden="true" />
        {isSubmitting ? "提交中" : "提交工单"}
      </button>
    </form>
  );
}
