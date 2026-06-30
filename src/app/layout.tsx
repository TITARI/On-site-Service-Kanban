import "@/styles/globals.css";
import type { Metadata } from "next";
import { QueryProvider } from "@/components/query-provider";

export const metadata: Metadata = {
  title: "内部协同看板",
  description: "移动端现场工单协同中心"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body><QueryProvider>{children}</QueryProvider></body>
    </html>
  );
}
