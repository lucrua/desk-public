import type { Metadata } from "next";
import { Newsreader, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Partner register serif. Italic faces included for blockquotes / lede.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

// Machine text: slugs, hashes, dates, refs, code blocks.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Desk",
  description: "Desk — partner-facing docs and operator workspace.",
};

// Applies the stored theme before first paint to avoid a flash of the wrong
// theme. Reads localStorage("hub-theme"); defaults to light.
const themeInitScript = `(function(){try{var t=localStorage.getItem("hub-theme");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      // The pre-paint themeInitScript flips data-theme to the stored value
      // before React hydrates, so the server-rendered `light` intentionally
      // differs from the live DOM in dark mode. Suppress the (expected,
      // one-level) attribute hydration warning on <html> only — same pattern
      // ThemeToggle uses on its own elements.
      suppressHydrationWarning
      className={`${newsreader.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
