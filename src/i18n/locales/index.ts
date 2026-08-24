// The language registry. One entry per config file in this directory — adding a language
// is: drop `xx.json` in beside en.json, import it here, add the line. Nothing else in the
// app names a language.
//
// Static imports rather than a dynamic require of the directory: Metro resolves the
// bundle graph at build time, so a computed `require('./' + code + '.json')` would either
// fail to resolve or drag every file in unconditionally. An explicit map is also the
// thing TypeScript can check en.json against — see `Translations` below.
import en from './en.json';
import de from './de.json';

export const TRANSLATIONS = { en, de };

// The set of codes the app will accept, derived from the files above rather than declared
// separately, so the two can never drift.
export const SUPPORTED_LOCALES = Object.keys(TRANSLATIONS) as LocaleCode[];

export type LocaleCode = keyof typeof TRANSLATIONS;

// English is the reference: every other file is checked against its shape, so a missing or
// misspelled key in a translation is a type error rather than a `[missing "de.x.y"]`
// string on screen at runtime.
type Translations = typeof en;

// Deliberately a no-op at runtime — it exists only for the compile-time check.
const _check: Record<Exclude<LocaleCode, 'en'>, Translations> = { de };
void _check;
