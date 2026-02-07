import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Allow all requests through. Auth is checked on the client (AuthHydrate) so that on refresh the user stays on the same page; only after verifying "no token" we redirect to /login?from=currentPath. */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon|brand|logo|.*\\.(?:svg|png|ico)$).*)',
  ],
};
