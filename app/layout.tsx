import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Perpa — agency ERP", description: "Estimates, delivery and profitability for service businesses." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
