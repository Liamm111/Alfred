import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe } from '../_lib/server-api';
import { ServiceDown } from '../_components/ErrorState';
import { LogoutButton } from '../_components/LogoutButton';

export const dynamic = 'force-dynamic';

/** Server-side session check: no private page renders without a valid session (fails closed to /login). */
export default async function PrivateLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (me.status === 'anon') redirect('/login');
  if (me.status === 'down') return <ServiceDown />;
  return (
    <>
      <header className="topbar">
        <nav aria-label="Navigation principale">
          <Link href="/">Accueil</Link>
          <Link href="/settings">Paramètres</Link>
        </nav>
        <LogoutButton />
      </header>
      {children}
    </>
  );
}
