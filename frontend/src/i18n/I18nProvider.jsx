import { useCallback, useEffect, useMemo, useState } from 'react';
import { i18nApi } from '../api/i18n.js';
import {
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  storedLanguage,
  translate,
} from './translations.js';
import { I18nContext } from './context.js';

export function I18nProvider({ children }) {
  const [language, setLanguage] = useState(storedLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* storage is optional */ }
  }, [language]);

  const refreshLanguage = useCallback(async () => {
    const response = await i18nApi.getLanguage();
    const next = normalizeLanguage(response?.language);
    setLanguage(next);
    return next;
  }, []);

  const changeLanguage = useCallback(async (value) => {
    const next = normalizeLanguage(value);
    if (next === language) return next;
    const previous = language;
    setLanguage(next);
    try {
      const response = await i18nApi.setLanguage(next);
      const persisted = normalizeLanguage(response?.language);
      setLanguage(persisted);
      return persisted;
    } catch (error) {
      setLanguage(previous);
      throw error;
    }
  }, [language]);

  const t = useCallback((key, variables) => translate(language, key, variables), [language]);
  const value = useMemo(() => ({ changeLanguage, language, refreshLanguage, t }), [changeLanguage, language, refreshLanguage, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
