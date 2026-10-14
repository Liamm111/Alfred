export function ServiceDown() {
  return (
    <main className="wrap">
      <h1>Service indisponible</h1>
      <div className="alert error" role="alert">
        Impossible de joindre le serveur pour le moment. Tes données ne sont pas perdues. Recharge la page dans un instant.
      </div>
      <a className="btn" href="">Réessayer</a>
    </main>
  );
}
