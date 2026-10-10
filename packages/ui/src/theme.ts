export const THEMES = ["dark", "light"] as const;
export const DENSITIES = ["compact", "comfortable"] as const;
export type Theme = (typeof THEMES)[number];
export type Density = (typeof DENSITIES)[number];

export const ICON_SIZES = Object.freeze({
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const);

export const THEME_STORAGE_KEY = "skillplane.theme";
export const DENSITY_STORAGE_KEY = "skillplane.density";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.includes(value as Theme);
}

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && DENSITIES.includes(value as Density);
}

export function applyAppearance(theme: Theme, density: Density = "compact"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  localStorage.setItem(DENSITY_STORAGE_KEY, density);
}
