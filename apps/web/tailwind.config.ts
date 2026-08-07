import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--ui-border) / <alpha-value>)',
        input: 'hsl(var(--ui-input) / <alpha-value>)',
        ring: 'hsl(var(--ui-ring) / <alpha-value>)',
        background: 'hsl(var(--ui-background) / <alpha-value>)',
        foreground: 'hsl(var(--ui-foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--ui-primary) / <alpha-value>)',
          foreground: 'hsl(var(--ui-primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--ui-secondary) / <alpha-value>)',
          foreground: 'hsl(var(--ui-secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--ui-destructive) / <alpha-value>)',
          foreground: 'hsl(var(--ui-destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--ui-muted) / <alpha-value>)',
          foreground: 'hsl(var(--ui-muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--ui-accent) / <alpha-value>)',
          foreground: 'hsl(var(--ui-accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--ui-popover) / <alpha-value>)',
          foreground: 'hsl(var(--ui-popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--ui-card) / <alpha-value>)',
          foreground: 'hsl(var(--ui-card-foreground) / <alpha-value>)',
        },
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6477f2',
          600: '#5368ee',
          700: '#4054d2',
          800: '#3444a8',
          900: '#2f3b83',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        lg: 'var(--ui-radius)',
        md: 'calc(var(--ui-radius) - 2px)',
        sm: 'calc(var(--ui-radius) - 4px)',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
