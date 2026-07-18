export type ErrorLike = {
  message?: unknown;
  error?: unknown;
  error_description?: unknown;
  reason?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

function clean(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text && text !== '{}' && text !== '[]' ? text : '';
  } catch {
    return '';
  }
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!error) return fallback;
  if (typeof error === 'string') {
    const value = error.trim();
    return value && value !== '[]' && value !== '{}' ? value : fallback;
  }
  if (error instanceof Error) return error.message.trim() || fallback;
  if (Array.isArray(error)) {
    const values = error.map((item) => errorMessage(item, '')).filter(Boolean);
    return values.join(' | ') || fallback;
  }

  const value = error as ErrorLike;
  const main = clean(value.message) || clean(value.error_description) || clean(value.error) || clean(value.reason);
  const details = clean(value.details);
  const hint = clean(value.hint);
  const code = clean(value.code);
  const parts = [main, code ? `Code: ${code}` : '', details ? `Details: ${details}` : '', hint ? `Hint: ${hint}` : ''].filter(Boolean);
  return parts.join(' | ') || safeJson(error) || fallback;
}

export function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  return clean((error as ErrorLike).code);
}

export function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as ErrorLike).status ?? (error as ErrorLike).statusCode;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function isTransientError(error: unknown): boolean {
  const code = errorCode(error).toUpperCase();
  const status = httpStatus(error);
  const message = errorMessage(error, '').toLowerCase();

  if (status && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['57014', '53300', '53400', '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '08P01', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)) return true;

  return [
    'failed to fetch',
    'fetch failed',
    'networkerror',
    'network error',
    'load failed',
    'timeout',
    'timed out',
    'statement timeout',
    'too many connections',
    'connection reset',
    'connection closed',
    'connection terminated',
    'socket hang up',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'rate limit',
    'temporarily unavailable'
  ].some((part) => message.includes(part));
}

export function isAuthError(error: unknown): boolean {
  const code = errorCode(error).toUpperCase();
  const status = httpStatus(error);
  const message = errorMessage(error, '').toLowerCase();
  return status === 401 || status === 403 || ['PGRST301', 'PGRST302'].includes(code) || message.includes('jwt expired') || message.includes('not authenticated') || message.includes('not signed in');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: (attempt: number) => PromiseLike<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
  } = {}
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 2);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 5000);
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => isTransientError(error));

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error, attempt)) throw error;
      const jitter = Math.floor(Math.random() * 200);
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + jitter);
      await options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export class HttpRequestError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
    this.body = body;
  }
}

export async function readJsonResponse<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpRequestError(`Server returned an invalid response (HTTP ${response.status}).`, response.status, text.slice(0, 500));
  }
}

export async function fetchJson<T = Record<string, unknown>>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  const method = String(init.method || 'GET').toUpperCase();
  const defaultRetries = ['GET', 'HEAD'].includes(method) ? 2 : 0;
  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      const body = await readJsonResponse<Record<string, unknown>>(response);
      if (!response.ok) {
        throw new HttpRequestError(errorMessage(body, `Request failed with HTTP ${response.status}.`), response.status, body);
      }
      return body as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new HttpRequestError('Request timed out. Scout will retry safely.', 408);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }, { retries: options.retries ?? defaultRetries });
}
