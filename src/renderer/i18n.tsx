import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type AppLocale = 'zh' | 'en';

const LOCALE_STORAGE_KEY = 'vectrail.locale.v1';

function loadInitialLocale(): AppLocale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

interface I18nContextValue {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  toggleLocale: () => void;
  L: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  toggleLocale: () => {},
  L: (_zh, en) => en,
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<AppLocale>(loadInitialLocale);

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next: AppLocale = prev === 'zh' ? 'en' : 'zh';
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const L = useCallback((zh: string, en: string) => (locale === 'zh' ? zh : en), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, toggleLocale, L }),
    [locale, setLocale, toggleLocale, L]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
