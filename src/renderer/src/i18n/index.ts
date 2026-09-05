import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./zh.json";
import en from "./en.json";

const saved = localStorage.getItem("app-language");
const detected = navigator.language.startsWith("zh") ? "zh" : "en";

i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: saved || detected,
  fallbackLng: "en",
  interpolation: { escapeValue: false }
});

export function switchLanguage(lng: "zh" | "en"): void {
  i18n.changeLanguage(lng);
  localStorage.setItem("app-language", lng);
}

export default i18n;
