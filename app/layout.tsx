import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Als PWA installierbar: eigenes Icon, Vollbild ohne Browserleiste, eigener
// Eintrag im App-Umschalter. Updates kommen weiter ueber den Deploy, es gibt
// nichts zu paketieren und keinen Store-Review.
export const viewport: Viewport = {
  themeColor: "#D0231C",
  width: "device-width",
  initialScale: 1,
  // Verhindert das Zoomen beim Fokussieren von Eingabefeldern auf iOS,
  // was sich in einer installierten PWA wie ein Fehler anfuehlt.
  maximumScale: 1,
};

export const metadata: Metadata = {
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Vermieterente",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
  title: "OpenReply - Open source Instagram comment-to-DM automation",
  description:
    "A free, self-hosted ManyChat alternative. Send an Instagram DM automatically when someone comments a keyword on your post or reel, using the official Meta API.",
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "social commerce",
    "manychat alternative",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full dark">
      <body className="min-h-full bg-background text-foreground font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
