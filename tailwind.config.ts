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
        // White-first background with a moderate "blush" of the brand blue
        // and teal in opposite corners — used on the picker, admin login and
        // usher PIN screens (owner decision 2026-09-10: white is the main
        // colour there, the navy radial is reserved for the admin sidebar).
        'brand-blush':
          'radial-gradient(85% 60% at 8% -8%, rgba(11,99,230,0.10) 0%, rgba(11,99,230,0) 60%), radial-gradient(85% 60% at 96% 108%, rgba(20,201,214,0.12) 0%, rgba(20,201,214,0) 60%), #ffffff',
      },
    },
  },
  plugins: [],
} satisfies Config;
