import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "Acme Analytics",
  description: "Dashboards your team actually reads.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
