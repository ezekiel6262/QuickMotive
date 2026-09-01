import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuickMotive - Creative & NFT Agent on BNB Chain",
  description:
    "Eleven individually priced creative and NFT skills, callable by any agent over MCP and paid per call in USDT on BNB Smart Chain."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
