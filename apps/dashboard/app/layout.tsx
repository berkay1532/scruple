import "./globals.css";
import { Providers } from "@/components/providers"; // Task 4 adds real providers; create a passthrough now

export const metadata = { title: "Scruple Dashboard", description: "USDC billing on Arc" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
