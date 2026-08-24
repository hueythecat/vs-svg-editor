// Makes the resolved locale a React value, so changing it re-renders the tree.
//
// Every panel in the editor is React.memo'd and most take no string props, so setting
// i18n.locale on its own would repaint nothing. Reading the locale through context gives
// each of them a subscription: a memoised child that calls useT() still re-renders when
// the language changes, without the parent having to thread strings down to it.
//
// `?lang=` is applied on mount, not during the render that hydrates — deliberately.
//
// A production build is `expo export`, which PRE-RENDERS each route to HTML at build
// time, with no request and therefore no query string. That HTML is in the deployment's
// default language whatever ?lang= later says. Resolving the param during the first
// client render made it disagree with the markup it was hydrating, and React tore that
// subtree down and rebuilt it — visibly correct in the end, but by way of a hydration
// error (#418) on every German load.
//
// So the first render is always the base locale, matching whatever was pre-rendered, and
// the effect below switches to the URL's language once hydration has committed. The cost
// is one paint of the default language on a ?lang= load; what is on screen for that paint
// is the empty drop zone, before any artwork has loaded.
//
// Both sources of the param are consulted because they answer at different moments: the
// router's params, and window.location.search for the case where the router has not
// resolved the query string yet.
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useGlobalSearchParams } from 'expo-router';

import {
  baseLocale, i18n, localeFromSearch, resolveLocale,
  type LocaleCode, type TranslateOptions,
} from './index';

type I18nValue = {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => void;
  t: (key: string, options?: TranslateOptions) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const params = useGlobalSearchParams<{ lang?: string }>();
  // Not resolveLocale(params) — see the note above on why the first render ignores the URL.
  const [locale, setLocale] = useState<LocaleCode>(baseLocale);

  // Keep the shared instance in step: it is what the non-React callers read — svg-utils
  // naming a layer, the AI status messages, the error strings. An effect rather than a
  // render-phase assignment, so rendering stays free of side effects and the mutation
  // never happens on the server, where one module-level locale would be shared across
  // concurrent requests. Nothing is missed in the gap: every one of those callers runs
  // from an event or a fetch, long after this has committed, and the one exception —
  // the initial textForm state — is created on the first render, where `locale` is
  // baseLocale() and the instance already agrees.
  useEffect(() => { i18n.locale = locale; }, [locale]);

  useEffect(() => {
    // localeFromSearch() first: it reads the address bar directly, so it is right even on
    // the render where the router has not parsed the query string yet.
    const next = localeFromSearch() ?? resolveLocale(params?.lang);
    setLocale((cur) => (cur === next ? cur : next));
  }, [params?.lang]);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    // Bound to `locale` so the identity changes with the language — memoised consumers
    // that hold onto `t` still get the new copy.
    t: (key: string, options?: TranslateOptions) => i18n.t(key, { locale, ...options }),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  // No provider (a component rendered outside the app shell, or a test) is not a reason
  // to crash — fall back to the module-level instance, which is already at baseLocale().
  if (ctx) return ctx;
  return {
    locale: i18n.locale as LocaleCode,
    setLocale: () => {},
    t: (key: string, options?: TranslateOptions) => i18n.t(key, options),
  };
}

// The common case: just the translate function.
export function useT() {
  return useI18n().t;
}
