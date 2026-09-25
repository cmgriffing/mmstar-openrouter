/** Durable JSON serialization shared by run storage and its checkpoint helpers. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
