import type { Metadata } from "next";
import { ThemeProvider } from "../components/theme-provider";
import "./globals.css";
import "./avenue-brand-preview.css";

export const metadata: Metadata = {
  title: "Avenue Z Intelligence",
  description: "Shared client analytics, evidence, and daily reviews for Avenue Z.",
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
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased"><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
