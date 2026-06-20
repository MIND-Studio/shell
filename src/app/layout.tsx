import { ThemeProvider } from "@mind-studio/ui";
import { mind } from "@mind-studio/ui/themes";
import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Fleet webfonts — the Mind theme's font axis (ui 0.4.0) references these three
// CSS vars (--font-fraunces / --font-hanken / --font-jb).
const display = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb", display: "swap" });

export const metadata: Metadata = {
  title: "Mind Shell — the everything app",
  description:
    "A Dock-style shell that wraps your Mind identity and hosts every app on one surface — shipping with Vault, a zero-knowledge password manager.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The shell renders its own chrome (rail, switchers, account menu) inside the
  // /shell route, so the root layout stays minimal: just the theme shell.
  return (
    <html
      lang="en"
      data-mind-theme="mind"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="h-full bg-background text-foreground">
        <ThemeProvider
          theme={mind}
          defaultTheme="dark"
          enableSystem={false}
          storageKey="mind-shell-theme"
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
