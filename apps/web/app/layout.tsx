import type { ReactNode } from "react";

export const metadata = {
  title: "feedxml",
  description: "Product-feed ingestion",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
