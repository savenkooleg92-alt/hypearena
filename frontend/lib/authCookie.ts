const AUTH_COOKIE_NAME = 'hype-auth-token';
const MAX_AGE_DAYS = 30;

export function setAuthCookie(token: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; max-age=${MAX_AGE_DAYS * 24 * 60 * 60}; SameSite=Lax`;
}

export function clearAuthCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0`;
}

export const AUTH_COOKIE_NAME_EXPORT = AUTH_COOKIE_NAME;
