import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Klawpen Builder",
  description:
    "Create, edit, preview, and export AI-generated websites from the Klawpen Builder workspace.",
  keywords: [
    "AI",
    "full stack",
    "development",
    "containers",
    "Next.js",
    "deployment",
    "coding assistant",
  ],
  authors: [{ name: "Klawpen" }],
  creator: "Klawpen",
  publisher: "Klawpen",
  openGraph: {
    title: "Klawpen Builder",
    description:
      "Create, edit, preview, and export AI-generated websites from the Klawpen Builder workspace.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Klawpen Builder",
    description:
      "Create, edit, preview, and export AI-generated websites from the Klawpen Builder workspace.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html suppressHydrationWarning={true} lang="en">
      <body
        suppressHydrationWarning={true}
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Toaster
          position="top-right"
          toastOptions={{
            className: "motion-toast bg-gray-800 text-white",
            style: {
              fontFamily: "var(--font-geist-sans)",
              fontSize: "14px",
            },
          }}
        />
        {children}
      </body>
    </html>
  );
}
