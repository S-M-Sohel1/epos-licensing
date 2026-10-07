/** Reads a till's JSON body. Tills send PascalCase; either case is accepted. */
export function readFields(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) fields[key.charAt(0).toLowerCase() + key.slice(1)] = value;
    return fields;
  } catch {
    return null;
  }
}

export const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const invalid = (error: string) => json({ error, code: "invalid_body" }, 400);

export const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;
