import type { Config } from 'tailwindcss';

/** Every color is an RGB triplet CSS variable so `bg-accent/20` style alpha works. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Class names composed at runtime (`btn-${variant}` etc.) cannot be found by the scanner.
  safelist: [{ pattern: /^(btn|badge|diff|input)-/ }],
  theme: {
    fontFamily: {
      sans: ['var(--font-sans)'],
      mono: ['var(--font-mono)'],
    },
    fontSize: {
      xs: ['11px', { lineHeight: '15px' }],
      sm: ['12px', { lineHeight: '17px' }],
      base: ['13px', { lineHeight: '19px' }],
      md: ['14px', { lineHeight: '20px' }],
      lg: ['16px', { lineHeight: '22px' }],
      xl: ['20px', { lineHeight: '26px' }],
      '2xl': ['26px', { lineHeight: '32px' }],
    },
    borderRadius: {
      none: '0',
      sm: '4px',
      DEFAULT: '6px',
      md: '6px',
      lg: '10px',
      xl: '14px',
      full: '9999px',
    },
    extend: {
      colors: {
        canvas: v('bg-0'),
        panel: v('bg-1'),
        raised: v('bg-2'),
        field: v('bg-3'),
        line: v('border'),
        'line-strong': v('border-strong'),
        fg: v('fg'),
        muted: v('fg-muted'),
        faint: v('fg-faint'),
        accent: { DEFAULT: v('accent'), fg: v('accent-fg') },
        info: v('info'),
        ok: v('ok'),
        warn: v('warn'),
        danger: v('danger'),
        syn: {
          key: v('syn-key'),
          str: v('syn-str'),
          num: v('syn-num'),
          bool: v('syn-bool'),
          null: v('syn-null'),
        },
      },
      borderColor: {
        DEFAULT: `rgb(var(--border) / 1)`,
      },
      boxShadow: {
        pop: '0 8px 30px rgb(0 0 0 / 0.35), 0 1px 0 rgb(255 255 255 / 0.04) inset',
        card: '0 1px 2px rgb(0 0 0 / 0.2)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'pulse-dot': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'pulse-dot': 'pulse-dot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
