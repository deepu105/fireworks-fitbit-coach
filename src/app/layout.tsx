import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daily Wellbeing | Fitbit, Auth0 + Fireworks",
  description: "Review your Fitbit activity and sleep, then generate personalized daily wellbeing suggestions.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
