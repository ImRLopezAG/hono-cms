import type { ReactNode } from "react";

export const metadata = {
  title: "Hono CMS — Next.js example",
  description: "Same createCMS, served by Next.js App Router."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif" }}>{children}</body>
    </html>
  );
}
