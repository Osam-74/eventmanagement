import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Event Access Control',
  description: 'Wedding invitation QR access system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
