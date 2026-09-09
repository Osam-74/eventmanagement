'use client';

import { useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/**
 * Small "Install App" action. Renders only when the browser supports
 * programmatic PWA installation (Chrome/Android etc.). On unsupported
 * platforms (e.g. iOS Safari) it renders nothing and the app still works
 * normally from the browser. Installation is never required.
 */
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred || installed) return null;

  return (
    <button
      onClick={() => {
        deferred.prompt();
        setDeferred(null);
      }}
      className="mt-4 text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800"
    >
      Install App
    </button>
  );
}
