/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Source Sans 3"', 'system-ui', 'Segoe UI', 'sans-serif'],
        titulo: ['Lora', 'Georgia', 'serif'],
      },
      colors: {
        crema: '#F5F0E6',
        arena: { 300: '#C8B48A', 400: '#b9a273' },
        marca: { 50: '#f2f4ec', 100: '#e4e8d8', 200: '#cbd3b8', 500: '#7F8C6A', 600: '#69774f', 700: '#55623f' },
        cafe: { 700: '#5a4030', 800: '#46301f', 900: '#352316' },
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.97)' },
          to:   { opacity: '1', transform: 'translateY(0)     scale(1)'   },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateX(20px)' },
          to:   { opacity: '1', transform: 'translateX(0)'     },
        },
      },
      animation: {
        'fade-in':  'fadeIn 0.15s ease-out forwards',
        'slide-in': 'slideIn 0.25s ease-out forwards',
      },
    },
  },
  plugins: [],
}
