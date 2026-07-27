import { createContext, useContext } from 'react';
import { DEFAULT_LANGUAGE, translate } from './translations.js';

export const I18nContext = createContext(null);

export function useI18n() {
  return useContext(I18nContext) || {
    changeLanguage: async () => DEFAULT_LANGUAGE,
    language: DEFAULT_LANGUAGE,
    refreshLanguage: async () => DEFAULT_LANGUAGE,
    t: (key, variables) => translate(DEFAULT_LANGUAGE, key, variables),
  };
}
