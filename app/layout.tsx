import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "QuickMotive - OKX.ai Creative & NFT Agent Suite",
  description: "An Agent Service Provider exposing creative and NFT-analysis skills via A2MCP."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
