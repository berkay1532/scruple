import "./globals.css";
import { Providers } from "@/components/providers"; // Task 4 adds real providers; create a passthrough now
import { ToastProvider } from "@/components/ui";

export const metadata = { title: "Scruple Dashboard", description: "USDC billing on Arc" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <ToastProvider>{children}</ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
