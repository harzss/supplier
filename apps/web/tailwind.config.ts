import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff5f0',
          500: '#ff6a3d',
          600: '#e85a2c',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
