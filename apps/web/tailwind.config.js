/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Nebula palette — an original identity, not a copy of any existing brand.
        nebula: {
          950: "#0b0d1a",
          900: "#11142a",
          850: "#171b38",
          800: "#1e2342",
          700: "#2a2f55",
          600: "#3a4170",
          accent: "#6d5cff",
          accent2: "#37e0c0",
          danger: "#ff5c72",
          warn: "#ffb454",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
