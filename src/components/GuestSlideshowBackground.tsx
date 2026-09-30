'use client';

import { useEffect, useState } from 'react';

/**
 * Full-screen, endlessly sliding photo background for the guest page.
 *
 * - Every slide is exactly the viewport wide and tall, side by side with no gap,
 *   and the photo is cover-cropped so it fills any phone, tablet or desktop.
 * - The strip is rendered twice back to back and translated by exactly one
 *   strip-width, so the loop point is invisible and it never jumps or pauses.
 * - It moves to the RIGHT (the strip starts shifted left and eases toward 0).
 * - Speed is a fixed number of seconds PER PHOTO, so 3 photos and 40 photos
 *   move at the same pace.
 * - Only `transform` is animated (GPU friendly). Guests who ask their device
 *   for reduced motion get a still, slowly cross-fading photo instead.
 * - Photos that fail to load are dropped, so a bad link never leaves a hole.
 */
const SECONDS_PER_SLIDE = 7;

export function GuestSlideshowBackground({ urls }: { urls: string[] }) {
  const [ok, setOk] = useState<string[]>(urls);
  const [still, setStill] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => setOk(urls), [urls]);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setStill(m.matches);
    on(); m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    if (!still || ok.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % ok.length), 6000);
    return () => clearInterval(t);
  }, [still, ok.length]);

  if (ok.length === 0) return null;
  const drop = (u: string) => setOk((cur) => cur.filter((x) => x !== u));

  // A single photo can't "slide" against itself, so repeat it to make a strip.
  const base = ok.length === 1 ? [ok[0], ok[0]] : ok;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-black">
      {still ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={ok[i % ok.length]} src={ok[i % ok.length]} alt="" onError={() => drop(ok[i % ok.length])} className="h-full w-full object-cover" />
      ) : (
        <div
          className="slideshow-track flex h-full will-change-transform"
          style={{ width: `${base.length * 2 * 100}vw`, ['--strip' as string]: `${base.length * 100}vw`, ['--dur' as string]: `${base.length * SECONDS_PER_SLIDE}s` }}
        >
          {[...base, ...base].map((u, n) => (
            <div key={n} className="h-full w-screen shrink-0 bg-cover bg-center" style={{ backgroundImage: `url("${u}")` }} />
          ))}
        </div>
      )}
      {/* legibility layer so the upload card and text stay readable over any photo */}
      <div className="absolute inset-0 bg-black/35" />
      <style>{`
        .slideshow-track { animation: slideshow-right var(--dur) linear infinite; }
        @keyframes slideshow-right { from { transform: translate3d(calc(var(--strip) * -1), 0, 0); } to { transform: translate3d(0, 0, 0); } }
      `}</style>
    </div>
  );
}
