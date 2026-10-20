// Root layout for every page: <html lang="en">, the viewport/theme tags, icons, fonts and veyl.css. Page-specific head tags
// come from <PageHead> inside each page. Static files (veyl.css, brand/, the legacy scripts) are not in web/: build-site.js
// copies them from site/ and brand/ next to the export, so they are referenced by relative name, as before.
import type { Viewport } from 'next';
import type { ReactNode } from 'react';

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0A0B09', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="brand/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="brand/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="apple-touch-icon" href="brand/apple-touch-icon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" precedence="veyl-base" />
        <link rel="stylesheet" href="veyl.css" precedence="veyl-base" />
      </head>
      <body>{children}</body>
    </html>
  );
}
