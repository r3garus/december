export function stripIndent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let output = strings[0] || "";

  for (let index = 0; index < values.length; index += 1) {
    output += String(values[index]) + (strings[index + 1] || "");
  }

  const lines = output.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) return output.trim();

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => line.match(/^(\s*)/)?.[1]?.length || 0)
  );

  return lines
    .map((line) => (line.trim().length > 0 ? line.slice(minIndent) : ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

export const stripIndents = stripIndent;
