import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "半导体价格追踪中心",
  description: "半导体、PCB、结构件等品类的采购价格追踪与趋势看板。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
