import type { IOProvider } from "@flowscripter/pluggable-io-framework-api";

/** Joins a child name onto a container key using the provider's own rule, else with `/`. */
export function joinKey(provider: IOProvider, containerKey: string, name: string): string {
  if (provider.joinKey) {
    return provider.joinKey(containerKey, name);
  }
  if (name === "") return containerKey;
  if (containerKey === "") return name;
  let end = containerKey.length;
  while (end > 0 && containerKey[end - 1] === "/") end--;
  return `${containerKey.slice(0, end)}/${name}`;
}

/** The last segment of a key, treating both `/` and `\` as separators. */
export function baseName(key: string): string {
  const segments = key.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.at(-1) ?? key;
}
