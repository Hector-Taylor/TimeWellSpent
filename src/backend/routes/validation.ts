import { ZodError, z } from 'zod';

export function formatRouteError(error: unknown): string {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    if (!first) return 'Invalid request';
    const path = first.path.length ? first.path.join('.') : 'request';
    return `${path}: ${first.message}`;
  }
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

export function coerceClampedInt(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const parsed = z.coerce.number().int().safeParse(value);
  if (!parsed.success) return fallback;
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, parsed.data));
}

export function parsePositiveInt(value: unknown): number {
  return z.coerce.number().int().positive().parse(value);
}

export function parseOptionalNonEmptyString(value: unknown): string | undefined {
  const schema = z.preprocess(
    (input) => (typeof input === 'string' && input.trim() === '' ? undefined : input),
    z.string().trim().min(1).optional()
  );
  return schema.parse(value);
}

export { z };
