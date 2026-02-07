import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        /* Dark theme surfaces (use with dark: prefix) */
        dark: {
          base: '#0f172a',
          card: '#111827',
          'card-hover': '#1a2235',
          secondary: '#1f2933',
          border: 'rgba(255,255,255,0.08)',
          'table-hover': 'rgba(255,255,255,0.04)',
          'text-primary': '#e5e7eb',
          'text-secondary': '#9ca3af',
          'text-muted': '#6b7280',
          'live-bg': '#064e3b',
          'live-text': '#6ee7b7',
          'upcoming-bg': '#1e293b',
          'upcoming-text': '#cbd5f5',
          'ended-bg': '#1e3a8a',
          'ended-text': '#93c5fd',
        },
      },
    },
  },
  plugins: [],
}
export default config
