import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  tone?: "error" | "status";
};

export function StatusMessage({ children, tone = "status" }: Props) {
  if (tone === "error") return <p className="form-message" role="alert">{children}</p>;
  return <p aria-live="polite" className="form-message" role="status">{children}</p>;
}
