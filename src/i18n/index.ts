// UI language.
//
// The editor is embedded by a host page, so the language is a property of *how it was
// opened*, not of the device: `…/<uuid>?lang=de` renders the whole interface in German.
// Resolution order, first hit wins:
//
//   1. ?lang= on the URL          — the host page's explicit choice
//   2. EXPO_PUBLIC_DEFAULT_LANGUAGE — this deployment's default
//   3. the device / browser locale — expo-localization
//   4. 'en'
//
// Anything unrecognised at any step falls through to the next, so `?lang=klingon` gets
// the deployment default rather than a blank UI.
//
// Copy itself lives in locales/*.json — see locales/index.ts.
import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';

import { SUPPORTED_LOCALES, TRANSLATIONS, type LocaleCode } from './locales';

export { SUPPORTED_LOCALES, type LocaleCode };

export const FALLBACK_LOCALE: LocaleCode = 'en';

// As with the other EXPO_PUBLIC_ flags (see lib/env.ts), the name has to appear as a
// literal `process.env.EXPO_PUBLIC_…` expression: Expo inlines these by static
// substitution at build time, so a computed key reads undefined. The unprefixed
// DEFAULT_LANGUAGE in .env is server-only and would never reach the browser, which is
// where every one of these strings is rendered.
const ENV_DEFAULT = process.env.EXPO_PUBLIC_DEFAULT_LANGUAGE;

// 'de-AT', 'DE', 'de_DE' → 'de'. Hosts pass whatever their own locale machinery holds;
// only the base language selects a file, since that is what the files are keyed by.
export function normalizeLocale(raw: string | null | undefined): LocaleCode | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as string[]).includes(base) ? (base as LocaleCode) : null;
}

// Step 3. Wrapped because expo-localization reads native/browser state that can be absent
// during server rendering, and a missing device locale is not a reason to fail to render.
function deviceLocale(): LocaleCode | null {
  try {
    for (const l of getLocales()) {
      const hit = normalizeLocale(l.languageCode ?? l.languageTag);
      if (hit) return hit;
    }
  } catch {
    /* no localization module available here — fall through */
  }
  return null;
}

// The deployment default plus the device, with no URL involved. This is what the server
// renders with, and what the client starts from before it has looked at the URL.
export function baseLocale(): LocaleCode {
  return normalizeLocale(ENV_DEFAULT) ?? deviceLocale() ?? FALLBACK_LOCALE;
}

// The full resolution, given whatever the caller could find for `?lang=`. The provider
// passes the router's params; `localeFromSearch` below covers the plain-web case.
export function resolveLocale(langParam?: string | string[] | null): LocaleCode {
  const param = Array.isArray(langParam) ? langParam[0] : langParam;
  return normalizeLocale(param) ?? baseLocale();
}

// ?lang= straight off the address bar. Only ever answers on the client — during server
// rendering there is no location to read, and the provider falls back to baseLocale().
export function localeFromSearch(): LocaleCode | null {
  if (typeof window === 'undefined') return null;
  return normalizeLocale(new URLSearchParams(window.location.search).get('lang'));
}

export const i18n = new I18n(TRANSLATIONS);

// A key a translation file hasn't caught up with renders in English rather than as
// `[missing "de.…"]`, so a half-finished language file is still a usable UI.
i18n.defaultLocale = FALLBACK_LOCALE;
i18n.enableFallback = true;
i18n.locale = baseLocale();

export type TranslateOptions = Record<string, unknown>;

// Module-level translate, for the code that isn't a React component: parsing, exports,
// AI status text, generated layer names. Reads whatever locale is currently set — which
// the provider owns. Components should use `useT()` from ./provider instead, so that a
// locale change actually re-renders them.
export function t(key: string, options?: TranslateOptions): string {
  return i18n.t(key, options);
}
