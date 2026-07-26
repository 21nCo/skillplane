/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-svelte"],
  printWidth: 88,
  proseWrap: "preserve",
  semi: true,
  singleQuote: false,
  svelteSortOrder: "options-scripts-markup-styles",
  trailingComma: "all",
};
