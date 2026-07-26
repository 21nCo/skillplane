try {
  const stored = localStorage.getItem("skillplane.theme");
  const theme =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = "comfortable";
} catch {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.density = "comfortable";
}
