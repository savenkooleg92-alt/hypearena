'use client';

import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-card mt-auto">
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-600 dark:text-dark-text-secondary">
          <Link href="/terms" className="hover:text-primary-600 dark:hover:text-primary-400 transition">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-primary-600 dark:hover:text-primary-400 transition">
            Privacy Policy
          </Link>
          <Link href="/faq" className="hover:text-primary-600 dark:hover:text-primary-400 transition">
            FAQ
          </Link>
        </div>
      </div>
    </footer>
  );
}
