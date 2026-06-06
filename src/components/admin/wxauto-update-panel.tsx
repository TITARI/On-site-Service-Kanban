"use client";

import { useState } from "react";
import type { WxautoRelease } from "@/lib/domain/types";

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function hashPrefix(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

export function WxautoUpdatePanel({
  releases,
  onPublished
}: {
  releases: WxautoRelease[];
  onPublished: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const token = String(formData.get("publishToken") ?? "");
    formData.delete("publishToken");
    setIsPublishing(true);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/wxauto-updates", {
        method: "POST",
        headers: { "x-update-publish-token": token },
        body: formData
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "发布失败");
      }
      form.reset();
      setStatus("桌面更新已发布");
      await onPublished();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "发布失败");
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <section className="admin-card config-list" id="admin-wxauto-updates" aria-label="wxauto 桌面更新">
      <div className="admin-card-head">
        <div>
          <h3>wxauto 桌面更新</h3>
          <p>上传签名后的 Windows 桌面安装包，供客户端检查更新和下载。</p>
        </div>
        <span>{releases.length} 个版本</span>
      </div>
      <form className="config-list-form" noValidate onSubmit={publish}>
        <article className="config-edit-card">
          <strong className="config-edit-title">发布新版本</strong>
          <div className="config-edit-grid">
            <label>
              <span>版本号</span>
              <input name="version" placeholder="0.2.0" aria-label="版本号" required />
            </label>
            <label>
              <span>发布通道</span>
              <select name="channel" defaultValue="stable" aria-label="发布通道">
                <option value="stable">stable</option>
                <option value="beta">beta</option>
              </select>
            </label>
            <label>
              <span>发布令牌</span>
              <input name="publishToken" type="password" aria-label="发布令牌" autoComplete="off" required />
            </label>
            <label>
              <span>安装包</span>
              <input name="installer" type="file" accept=".exe" aria-label="安装包" required />
            </label>
          </div>
          <label>
            <span>发布说明</span>
            <textarea name="releaseNotes" aria-label="发布说明" placeholder="本次更新内容" required />
          </label>
          <p className="config-lock-note">发布令牌只随本次请求发送，不会保存在浏览器状态或配置中。</p>
          {status && <p className="config-lock-note" role="status">{status}</p>}
          <button className="secondary-button" type="submit" disabled={isPublishing}>
            {isPublishing ? "发布中" : "发布桌面更新"}
          </button>
        </article>
      </form>
      <div className="admin-log-table">
        <div className="admin-log-row admin-log-head">
          <span>版本</span>
          <span>通道</span>
          <span>SHA-256</span>
          <span>时间</span>
          <span>文件</span>
        </div>
        {releases.map((release) => (
          <div className="admin-log-row" key={`${release.channel}-${release.version}`}>
            <strong>{release.version}</strong>
            <span>{release.channel}</span>
            <code>{hashPrefix(release.sha256)}</code>
            <time>{shortDateTime(release.publishedAt)}</time>
            <span>{release.fileName}</span>
          </div>
        ))}
        {releases.length === 0 && <p className="admin-empty-note">尚未发布桌面更新。</p>}
      </div>
    </section>
  );
}
