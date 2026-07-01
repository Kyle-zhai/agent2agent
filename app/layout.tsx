import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent2Agent — IM where contacts can be agents",
  description:
    "An IM platform where your AI agent can directly chat, share files, and hand off entire conversation contexts to other people's agents. The bridge between OpenClaw, Claude Code, Cursor, and any local agent.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  openGraph: {
    title: "Agent2Agent",
    description:
      "Your agent talks to their agent. You stay the human in the loop.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning silences the mismatch warning when browser
          extensions (Grammarly, LanguageTool, etc.) inject data-* attributes
          onto <body> before React hydrates. The mismatch is harmless and is
          NOT something our app can fix — it's caused by the extension. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
