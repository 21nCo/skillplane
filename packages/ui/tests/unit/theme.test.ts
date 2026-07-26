import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, test } from "vitest";
import { DENSITIES, ICON_SIZES, THEMES, isDensity, isTheme } from "../../src/theme.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color ${hex}`);
  return channels
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
    )
    .reduce((sum, channel, index) => {
      const weight = [0.2126, 0.7152, 0.0722][index] ?? 0;
      return sum + channel * weight;
    }, 0);
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  if (bright === undefined || dark === undefined) {
    throw new Error("Contrast requires two colors");
  }
  return (bright + 0.05) / (dark + 0.05);
}

function declarations(source: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of source.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/giu)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value);
  }
  return tokens;
}

describe("appearance contract", () => {
  test("publishes closed theme, density, and icon scales", () => {
    expect(THEMES).toEqual(["dark", "light"]);
    expect(DENSITIES).toEqual(["compact", "comfortable"]);
    expect(ICON_SIZES).toEqual({ xs: 12, sm: 14, md: 16, lg: 20, xl: 24 });
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(false);
    expect(isDensity("comfortable")).toBe(true);
    expect(isDensity("dense")).toBe(false);
  });

  test("text roles meet WCAG AA contrast in both themes", async () => {
    const source = await readFile(join(packageRoot, "src/styles/tokens.css"), "utf8");
    const lightStart = source.indexOf(':root[data-theme="light"]');
    const dark = declarations(source.slice(0, lightStart));
    const light = declarations(source.slice(lightStart));
    for (const tokens of [dark, light]) {
      const canvas = tokens.get("sp-color-canvas");
      const surface = tokens.get("sp-color-surface");
      const text = tokens.get("sp-color-text");
      const muted = tokens.get("sp-color-text-muted");
      const subtle = tokens.get("sp-color-text-subtle");
      expect(canvas && text ? contrast(canvas, text) : 0).toBeGreaterThanOrEqual(7);
      expect(surface && muted ? contrast(surface, muted) : 0).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(surface && subtle ? contrast(surface, subtle) : 0).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  test("every exported component compiles for the browser", async () => {
    const directory = join(packageRoot, "src/components");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".svelte"));
    expect(files).toHaveLength(15);
    for (const file of files) {
      const source = await readFile(join(directory, file), "utf8");
      const output = compile(source, {
        filename: file,
        generate: "client",
        modernAst: true,
      });
      expect(output.js.code.length, file).toBeGreaterThan(100);
      expect(output.warnings, file).toEqual([]);
    }
  });
});
