/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#000000',
        surface: '#0d0d0d',
        'surface-light': '#161616',
        border: '#1e1e1e',
        yellow: {
          300: '#FDE68A',
          400: '#F5CF00',  // Stellar brand yellow — primary accent
          500: '#D4A800',  // hover / pressed
          600: '#A38200',  // deep
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'yellow-glow': '0 0 20px rgba(245, 207, 0, 0.15)',
        'yellow-sm': '0 0 10px rgba(245, 207, 0, 0.08)',
      },
    },
  },
  plugins: [],
};
