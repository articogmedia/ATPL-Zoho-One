import type { Metadata, Viewport } from "next";
import { Nunito_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { PwaRegistration } from "@/components/PwaRegistration";
import { Toaster } from "sonner";
import "./globals.css";

const nunito = Nunito_Sans({ subsets: ["latin"], weight: ["400", "600", "700", "800"], variable: "--font-nunito", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ATPL Sales Portal", template: "%s | ATPL Sales Portal" },
  description: "Air Trendz Pvt Ltd sales portal for leads, quotations and site visits.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  icons: { icon: "/brand/atpl-mark-96.webp", apple: "/brand/atpl-mark-96.webp" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#36437f" };
export const preferredRegion = "bom1";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body className="font-sans antialiased">
        {children}
        <PwaRegistration />
        <Toaster richColors position="top-center" />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
