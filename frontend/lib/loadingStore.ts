import { create } from 'zustand';

/** Global loading state for premium loading screen. Use for initial load, navigation, API fetch, wallet ops, market loading. */
interface LoadingState {
  loading: boolean;
  message: string | null;
  /** When set, LoadingScreen shows this error instead of spinner (e.g. 404/401/timeout/network). */
  error: string | null;
  setLoading: (loading: boolean, message?: string | null) => void;
  setError: (error: string | null) => void;
}

export const useLoadingStore = create<LoadingState>((set) => ({
  loading: false,
  message: null,
  error: null,
  setLoading: (loading, message = null) => set({ loading, message, ...(loading ? { error: null } : {}) }),
  setError: (error) => set({ error, loading: false }),
}));
