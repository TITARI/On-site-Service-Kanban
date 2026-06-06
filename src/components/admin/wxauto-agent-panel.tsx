import type { WxautoAgent } from "@/lib/domain/types";

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function wechatProcessText(state: WxautoAgent["wechatProcessState"]) {
  if (state === "running") return "微信进程运行中";
  if (state === "not_running") return "微信进程未运行";
  return "微信进程未知";
}

function wechatLoginText(state: WxautoAgent["wechatLoginState"]) {
  if (state === "logged_in") return "微信已登录";
  if (state === "logged_out") return "微信未登录";
  return "微信登录状态未知";
}

export function WxautoAgentPanel({ agents }: { agents: WxautoAgent[] }) {
  return (
    <section className="admin-card" aria-label="wxauto 桌面客户端">
      <div className="admin-card-head">
        <div>
          <h3>wxauto 桌面客户端</h3>
          <p>桌面客户端、微信进程和最近心跳状态</p>
        </div>
        <span>{agents.length} 台</span>
      </div>
      {agents.length === 0 ? (
        <p className="admin-empty-note">尚无桌面客户端连接。</p>
      ) : agents.map((agent) => (
        <article className="message-record-card" key={agent.id}>
          <div>
            <strong>{agent.displayName}</strong>
            <span>{agent.appVersion} / worker {agent.workerVersion}</span>
          </div>
          <p>{wechatLoginText(agent.wechatLoginState)}</p>
          <small>{wechatProcessText(agent.wechatProcessState)}</small>
          <small>{agent.safetyMode === "strict" ? "严格安全模式" : agent.safetyMode}</small>
          <small>上次心跳 {shortDateTime(agent.lastSeenAt)}</small>
        </article>
      ))}
    </section>
  );
}
