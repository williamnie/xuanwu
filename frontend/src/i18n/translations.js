import ZH_CN_work from './zh-CN/work.js';
import ZH_CN_interface from './zh-CN/interface.js';
import ZH_CN_chat from './zh-CN/chat.js';
import ZH_CN_automations from './zh-CN/automations.js';
import EN_US_work from './en-US/work.js';
import EN_US_interface from './en-US/interface.js';
import EN_US_chat from './en-US/chat.js';
import EN_US_automations from './en-US/automations.js';

export const DEFAULT_LANGUAGE = 'zh-CN';
export const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en-US']);
export const LANGUAGE_STORAGE_KEY = 'xuanwu-language';

const ZH_CN = Object.freeze({ ...ZH_CN_work, ...ZH_CN_interface, ...ZH_CN_chat, ...ZH_CN_automations });

const EN_US = Object.freeze({ ...EN_US_work, ...EN_US_interface, ...EN_US_chat, ...EN_US_automations });

const RESOURCES = Object.freeze({ 'zh-CN': ZH_CN, 'en-US': EN_US });

export function availableTranslationKeys(language) {
  return Object.keys(RESOURCES[normalizeLanguage(language)] || {}).sort();
}

export function normalizeLanguage(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'en' || text.startsWith('en-')) return 'en-US';
  if (text === 'zh' || text.startsWith('zh-')) return 'zh-CN';
  return DEFAULT_LANGUAGE;
}

export function translate(language, key, variables = {}) {
  const normalized = normalizeLanguage(language);
  const template = RESOURCES[normalized]?.[key] ?? RESOURCES[DEFAULT_LANGUAGE]?.[key] ?? key;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => String(variables[name] ?? `{${name}}`));
}

export function storedLanguage() {
  try {
    return normalizeLanguage(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
