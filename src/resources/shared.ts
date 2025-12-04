import { z } from "every-plugin/zod";

const formatParseIssues = (label: string, error: z.ZodError): string =>
  `${label} validation failed: ${error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `${path} ${issue.message}`;
    })
    .join("; ")}`;

export const parseWithSchema = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(formatParseIssues(label, result.error));
  }
  return result.data;
};

export const parseWithSchemaOrThrow = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  friendlyMessage: string
): T => {
  try {
    return parseWithSchema(schema, value, label);
  } catch (error) {
    const wrapped = new Error(friendlyMessage);
    (wrapped as any).cause = error;
    throw wrapped;
  }
};

export const normalizePermissions = (
  permissions?: Record<string, unknown>
): Record<string, number> => {
  if (!permissions || typeof permissions !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(permissions).flatMap(([key, value]) => {
      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "boolean"
            ? value
              ? 1
              : 0
            : Number(value);
      if (!Number.isFinite(numeric)) return [];
      return [[key, numeric] as const];
    })
  );
};

export const normalizeHeaderValues = (headers: Record<string, string | number | undefined>) => {
  return Object.entries(headers ?? {}).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value === undefined || value === null) {
        return acc;
      }
      acc[key] = String(value);
      return acc;
    },
    {}
  );
};

export const normalizePage = (page: number | undefined, minimum: number): number => {
  if (typeof page !== "number" || !Number.isFinite(page)) {
    return minimum;
  }
  const normalized = Math.max(minimum, Math.floor(page));
  return normalized;
};
