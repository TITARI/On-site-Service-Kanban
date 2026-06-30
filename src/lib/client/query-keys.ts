type UserFilters = Readonly<{
  search: string;
  groupId: string;
  enabled: string;
  admin: string;
  binding: string;
}>;

export const queryKeys = {
  admin: {
    all: ["admin"] as const,
    session: ["admin", "session"] as const,
    bootstrap: ["admin", "bootstrap"] as const,
    logs: (limit: number) => ["admin", "wechat-order-logs", { limit }] as const,
    wxauto: ["admin", "wxauto-mcp"] as const,
    users: {
      all: ["admin", "users"] as const,
      list: (filters: UserFilters) => ["admin", "users", "list", filters] as const,
      identities: (platform: "wechat" | "wecom") => ["admin", "chat-identities", platform] as const
    }
  },
  mobile: {
    all: ["mobile"] as const,
    session: ["mobile", "session"] as const,
    loginConfig: ["mobile", "login-config"] as const,
    bootstrap: ["mobile", "bootstrap"] as const,
    ticket: (ticketId: string) => ["mobile", "ticket", ticketId] as const
  }
};
