import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Assistant IA de cours', description: 'Suivi de cours Zoom autorisés — alertes, comptes rendus, devoirs' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
