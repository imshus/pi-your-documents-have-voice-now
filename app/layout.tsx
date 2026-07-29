import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pi — Your documents have voice now",
  description: "Upload account documents and talk to Pi, your private voice assistant for financial paperwork.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
