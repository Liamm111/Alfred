import type { ReactNode } from 'react';

export const metadata = { title: 'AI Course Assistant', description: 'Assistant de suivi de cours — fondation (BLOC 01)' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>{children}</body>
    </html>
  );
}
