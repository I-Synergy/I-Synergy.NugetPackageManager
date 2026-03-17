export default function (): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}
