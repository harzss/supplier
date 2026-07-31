import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fdf1ec',
          100: '#f9dfd4',
          200: '#f3bda8',
          300: '#eb9475',
          400: '#e57650',
          500: '#df5b35',
          600: '#c94927',
          700: '#a83b22',
          800: '#873321',
          900: '#6e2d20',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
