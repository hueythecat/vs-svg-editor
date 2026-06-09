---
name: project-svg-edit
description: SVG Edit React Native project stack, structure, and setup decisions
metadata:
  type: project
---

Expo SDK 56 React Native project named "svg-edit" at /Users/jamescooper/git-repos/vs-svg-editor.

Stack:
- Expo Router (file-based navigation, `src/app/`)
- NativeWind v4.2.5 + Tailwind CSS v3.4.x for styling
- shadcn/ui-style components via React Native Reusables pattern (components in `src/components/ui/`)
- `class-variance-authority` + `clsx` + `tailwind-merge` for variant/cn utilities
- TypeScript strict mode, path alias `@/*` → `src/*`

Key config files:
- `tailwind.config.js` — NativeWind preset + HSL CSS variable token colors
- `metro.config.js` — withNativeWind wrapper, input: `./src/global.css`
- `babel.config.js` — babel-preset-expo with `jsxImportSource: "nativewind"` + `nativewind/babel`
- `nativewind-env.d.ts` — NativeWind types reference + `declare module "*.css"`
- `src/global.css` — Tailwind directives + HSL CSS variable theme tokens (light + dark)
- `src/lib/utils.ts` — `cn()` utility

**Why:** User wants Tailwind + shadcn/ui UX on React Native for an SVG editor app.
**How to apply:** When adding new UI components, follow the shadcn pattern in `src/components/ui/` using `cn()`, `cva()`, and the HSL color tokens.
