import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  email: string;
  username: string;
  balance: number;
  isAdmin?: boolean;
  isAnonymous?: boolean;
  createdAt?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  /** True after we have verified auth this session (no token, or GET /users/me completed). Never persisted. */
  authVerified: boolean;
  setAuth: (user: User, token: string) => void;
  setUser: (user: User) => void;
  setAuthVerified: (verified: boolean) => void;
  logout: () => void;
  updateBalance: (balance: number) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      authVerified: false,
      setAuth: (user, token) => {
        localStorage.setItem('token', token);
        set({
          user: { ...user, isAdmin: user.isAdmin === true },
          token,
          authVerified: true,
        });
      },
      setUser: (user) => {
        set({ user: { ...user, isAdmin: user.isAdmin === true } });
      },
      setAuthVerified: (verified) => set({ authVerified: verified }),
      logout: () => {
        localStorage.removeItem('token');
        set({ user: null, token: null, authVerified: true });
      },
      updateBalance: (balance) =>
        set((state) => ({
          user: state.user ? { ...state.user, balance } : null,
        })),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
