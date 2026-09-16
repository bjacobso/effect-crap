import * as Minimatch from "minimatch";

export const defaults = [
  "**/generated/**",
  "**/gen/**",
  "**/*.generated.{ts,tsx,mts,cts}",
  "**/*.gen.{ts,tsx,mts,cts}",
] as const;

/** Match project-relative POSIX paths. Negation is deliberately disabled. */
export function matcher(patterns: readonly string[]) {
  const matchers = patterns.map((pattern) => {
    if (!pattern.trim()) throw new Error("Exclusion patterns must not be empty");
    return new Minimatch.Minimatch(pattern, { dot: true, nonegate: true, nocomment: true });
  });
  return (file: string) => matchers.some((match) => match.match(file) || match.match(`${file}/`));
}
