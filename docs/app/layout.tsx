import "./global.css";

import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export const runtime = "nodejs";

export const metadata: Metadata = {
  metadataBase: new URL("https://skillplane.dev/docs"),
  title: {
    default: "Skillplane Docs",
    template: "%s · Skillplane Docs",
  },
  description:
    "Learn how to create, compose, contextualize, and improve reusable AI skills with Skillplane.",
  icons: {
    icon: [
      {
        url: "/docs/icon.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    shortcut: "/docs/favicon.ico",
    apple: [
      {
        url: "/docs/apple-icon.png",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
