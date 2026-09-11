import type { Config } from 'tailwindcss';

// Palette extracted directly from the Event Access logo: deep navy body,
// a vivid blue primary, and a cyan-teal accent from the arrow/mark.
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: {
            950: '#030c22',
            900: '#051531',
            800: '#0a2050',
            700: '#123166',
            600: '#1c4384',
          },
          blue: {
            600: '#094fc0',
            500: '#0b63e6',
            400: '#2f7cf0',
          },
          teal: {
            600: '#0ea8b3',
            500: '#14c9d6',
            400: '#3fdbe4',
          },
          ice: {
            50: '#f6f9fd',
            100: '#eaf1fb',
            200: '#dbe7f7',
          },
        },
      },
      boxShadow: {
        brand: '0 20px 45px -20px rgba(5, 21, 49, 0.35)',
      },
      backgroundImage: {
        'brand-radial': 'radial-gradient(120% 120% at 50% -10%, #123166 0%, #051531 55%, #030c22 100%)',
        // White-first ATMOSPHERE (redesign, 2026-09-11 — supersedes the more
        // "visible gradient section" version of this token): the page must
        // still read as ~90-95% plain white/off-white paper, with 2-3 very
        // soft, heavily-blurred pools of colour rather than an obvious
        // corner-to-corner gradient. Each stop fades out gradually over a
        // wide radius with no hard edge, peak opacity kept low (0.10-0.16),
        // and a third, extremely faint central glow adds atmosphere without
        // reading as "a blue section". Shared by the role picker, admin
        // login, usher PIN pad and the usher scanner — this one token is
        // what makes all four screens feel like the same product.
        'brand-blush':
          'radial-gradient(60% 55% at 92% -10%, rgba(63,219,214,0.16) 0%, rgba(63,219,214,0.06) 38%, rgba(63,219,214,0) 68%), ' +
          'radial-gradient(65% 60% at 4% 106%, rgba(11,99,230,0.14) 0%, rgba(11,99,230,0.05) 40%, rgba(11,99,230,0) 70%), ' +
          'radial-gradient(85% 70% at 50% 40%, rgba(47,124,240,0.05) 0%, rgba(47,124,240,0) 62%), ' +
          '#ffffff',
      },
    },
  },
  plugins: [],
} satisfies Config;
