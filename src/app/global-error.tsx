'use client';

/**
 * Root-level error boundary: if an unexpected client exception ever reaches
 * this point, show a useful message instead of Next.js's generic
 * "Application error: a client-side exception has occurred" screen.
 * This does NOT hide bugs — the message asks for the console error, and
 * this boundary only renders after the underlying exception has occurred.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
        <main style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: '0.5rem', color: '#57534e', fontSize: '0.875rem' }}>
            An unexpected error occurred: {error.message || 'unknown error'}
          </p>
          <p style={{ color: '#a8a29e', fontSize: '0.75rem', marginTop: '0.25rem' }}>
            If this persists, open the browser console and note the first red error.
          </p>
          <button
            onClick={() => reset()}
            style={{ marginTop: '1rem', padding: '0.5rem 1rem', borderRadius: '0.5rem', background: '#1c1917', color: '#fff' }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
