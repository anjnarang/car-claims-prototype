import "./globals.css";

export const metadata = {
  title: "Meridian Auto · AI Claims Assessment",
  description: "AI-powered car insurance damage assessment prototype",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
