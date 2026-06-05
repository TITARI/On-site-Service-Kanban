"use client";

import { useState } from "react";
import { LogIn, UserRound } from "lucide-react";
import { createMemberUser, storeUser, type CurrentUser } from "@/lib/client/auth";
import { userGroupsOf, type AppConfig } from "@/lib/seed";
import { StatusMessage } from "./status-message";

export function LoginPanel({ config, onLogin }: { config: AppConfig; onLogin: (user: CurrentUser) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const groups = userGroupsOf(config);

  function loginMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const phone = String(formData.get("phone") ?? "").trim();
    const groupId = String(formData.get("groupId") ?? "");
    const group = groups.find((item) => item.id === groupId) ?? groups[0];
    if (!name || !phone || !group) {
      setMessage("请填写真实姓名、联系电话和用户分组");
      return;
    }
    const user = createMemberUser(name, phone, group);
    storeUser(user);
    onLogin(user);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-hero-mark">
          <UserRound size={26} aria-hidden="true" />
        </div>
        <p className="eyebrow">现场协同登录</p>
        <h1 className="auth-title-single-line">登录后使用工单中心</h1>
        <p className="auth-copy">普通成员无需密码，填写真实姓名和联系电话即可提交、催单和查看自己的工单。</p>

        <form className="auth-form" onSubmit={loginMember}>
          <label>
            <span>真实姓名</span>
            <input name="name" autoComplete="name" placeholder="请输入真实姓名" required />
          </label>
          <label>
            <span>联系电话</span>
            <input name="phone" autoComplete="tel" inputMode="tel" placeholder="用于工单回访" required />
          </label>
          <label>
            <span>用户分组</span>
            <select name="groupId" defaultValue={groups[0]?.id} required>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </select>
          </label>
          {message && <StatusMessage tone="error">{message}</StatusMessage>}
          <button className="primary-button" type="submit"><LogIn size={18} aria-hidden="true" />进入看板</button>
        </form>
      </section>
    </main>
  );
}
