import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Top-level Studio view mode.
 *
 * `timeline` is the existing NLE/preview stage. `storyboard` replaces that stage
 * with the storyboard contact sheet. The mode is mirrored to the `?view=` query
 * param so it survives reloads and — importantly — so an agent can deep-link the
 * user straight into the storyboard by navigating the tab to `?view=storyboard`.
 */
export type StudioViewMode = "timeline" | "storyboard";
export type ViewModeGuard = (nextMode: StudioViewMode) => boolean;

const VIEW_QUERY_PARAM = "view";

function readViewModeFromUrl(): StudioViewMode {
  if (typeof window === "undefined") return "timeline";
  return new URLSearchParams(window.location.search).get(VIEW_QUERY_PARAM) === "storyboard"
    ? "storyboard"
    : "timeline";
}

function writeViewModeToUrl(mode: StudioViewMode): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (mode === "storyboard") {
    url.searchParams.set(VIEW_QUERY_PARAM, "storyboard");
  } else {
    url.searchParams.delete(VIEW_QUERY_PARAM);
  }
  window.history.replaceState(window.history.state, "", url);
}

export interface ViewModeValue {
  viewMode: StudioViewMode;
  /** Returns false when an active editor vetoes the transition. */
  setViewMode: (mode: StudioViewMode) => boolean;
  registerViewModeGuard: (guard: ViewModeGuard) => () => void;
}

/**
 * Owns the view-mode state — initial read from `?view=`, toggling, popstate sync.
 * Storyboard mode is always available; no flag gating.
 */
export function useViewModeState(): ViewModeValue {
  const [viewMode, setMode] = useState<StudioViewMode>(() => readViewModeFromUrl());
  const guardsRef = useRef(new Set<ViewModeGuard>());

  // Reflect genuine browser back/forward between history entries with a different
  // `?view=`. Note: our own writes use `replaceState` (below), which does NOT fire
  // `popstate`, so this listener never sees them — `setViewMode` updates state directly.
  // An agent deep-links by doing a full navigation to `?view=storyboard` (picked up by
  // the mount-time read); a scripted `pushState`/`replaceState` to `?view=` would not be
  // reflected here, by design.
  useEffect(() => {
    const onPopState = () => setMode(readViewModeFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const setViewMode = useCallback((mode: StudioViewMode) => {
    for (const guard of guardsRef.current) {
      if (!guard(mode)) return false;
    }
    setMode(mode);
    writeViewModeToUrl(mode);
    return true;
  }, []);

  const registerViewModeGuard = useCallback((guard: ViewModeGuard) => {
    guardsRef.current.add(guard);
    return () => {
      guardsRef.current.delete(guard);
    };
  }, []);

  return useMemo(
    () => ({ viewMode, setViewMode, registerViewModeGuard }),
    [viewMode, setViewMode, registerViewModeGuard],
  );
}

const ViewModeContext = createContext<ViewModeValue | null>(null);

export function useViewMode(): ViewModeValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error("useViewMode must be used within ViewModeProvider");
  return ctx;
}

export function ViewModeProvider({
  value,
  children,
}: {
  value: ViewModeValue;
  children: ReactNode;
}) {
  return <ViewModeContext value={value}>{children}</ViewModeContext>;
}
