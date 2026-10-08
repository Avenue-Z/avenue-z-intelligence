import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Avenue Z Intelligence",
  description: "Shared client analytics, evidence, and daily reviews for Avenue Z.",
  other: {
    "codex-preview": "development",
  },
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
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
