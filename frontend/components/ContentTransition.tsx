'use client';

import { usePathname } from 'next/navigation';

/** Wraps app content so that route changes get a soft fade-in (150–200ms). */
export default function ContentTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname ?? 'default'} className="animate-page-in">
      {children}
    </div>
  );
}
