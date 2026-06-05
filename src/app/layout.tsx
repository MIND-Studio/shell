import type { Metadata } from "next";
import { ThemeProvider } from "@mind-studio/ui";
import { mind } from "@mind-studio/ui/themes";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mind Shell — the everything app",
  description:
    "A Dock-style shell that wraps your Mind identity and hosts every app on one surface — shipping with Vault, a zero-knowledge password manager.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The shell renders its own chrome (rail, switchers, account menu) inside the
  // /shell route, so the root layout stays minimal: just the theme shell.
  return (
    <html lang="en" data-mind-theme="mind" suppressHydrationWarning>
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
