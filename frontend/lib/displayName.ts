/**
 * Public display name for chat, roulette, market comments, etc.
 * When user has "Hide my nickname" (isAnonymous), show "Anonymous" in public contexts.
 * The user always sees their own nickname in navbar/settings.
 */
export interface UserLike {
  username: string;
  isAnonymous?: boolean;
}

export function getPublicDisplayName(user: UserLike | null | undefined, forPublicContext: boolean): string {
  if (!user) return 'Unknown';
  if (forPublicContext && user.isAnonymous === true) return 'Anonymous';
  return user.username;
}
