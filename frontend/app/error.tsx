'use client';

import { useEffect } from 'react';

/**
 * Root error boundary. Catches ChunkLoadError (e.g. after deploy when old chunks 404)
 * and other runtime errors so navigation doesn't leave the app in a broken state.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error boundary:', error);
  }, [error]);

  const isChunkError =
    error?.name === 'ChunkLoadError' ||
    (typeof error?.message === 'string' &&
      (error.message.includes('Loading chunk') || error.message.includes('ChunkLoadError')));

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50 dark:bg-dark-base">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-dark-text-primary">
          {isChunkError ? 'Page failed to load' : 'Something went wrong'}
        </h1>
        <p className="text-sm text-gray-600 dark:text-dark-text-secondary">
          {isChunkError
            ? 'A new version may have been deployed. Please refresh the page to get the latest version.'
            : 'An unexpected error occurred. Try refreshing the page.'}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Refresh page
          </button>
          {!isChunkError && (
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 bg-gray-200 dark:bg-dark-card text-gray-800 dark:text-dark-text-primary rounded-lg hover:bg-gray-300 dark:hover:bg-dark-card-hover"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
