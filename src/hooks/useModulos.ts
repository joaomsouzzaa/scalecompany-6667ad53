import { useSyncExternalStore } from "react";

// Módulos (grupos do menu) que podem ser ligados/desligados em Configurações → Módulos.
export type ModuloKey = "eventos" | "inside" | "analytics" | "growth" | "financeiro";

const KEY = "modulos_visiveis";
const DEFAULTS: Record<ModuloKey, boolean> = { eventos: true, inside: true, analytics: true, growth: true, financeiro: true };

export function lerModulos(): Record<ModuloKey, boolean> {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}

export function setModulo(key: ModuloKey, val: boolean) {
  const m = lerModulos();
  m[key] = val;
  localStorage.setItem(KEY, JSON.stringify(m));
  window.dispatchEvent(new Event("modulos-changed"));
}

function subscribe(cb: () => void) {
  window.addEventListener("modulos-changed", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("modulos-changed", cb);
    window.removeEventListener("storage", cb);
  };
}
function getSnapshot() { return localStorage.getItem(KEY) || "{}"; }

// Hook que re-renderiza quando os módulos mudam (na sidebar e na página de config).
export function useModulos(): Record<ModuloKey, boolean> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return lerModulos();
}
