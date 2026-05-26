export function assertStorageKey(key: string): string {
  if (!key || key.startsWith("/") || key.includes("\\") || hasControlCharacter(key)) {
    throw new Error("Storage key must be a relative path.");
  }
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Storage key must not contain empty or traversal segments.");
  }
  return key;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
