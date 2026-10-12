export type DashboardTheme = "dark" | "light";

const STORAGE_KEY = "charon-dashboard-theme";

export function readDashboardTheme(): DashboardTheme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* private mode */
  }
  return "dark";
}

export function persistDashboardTheme(theme: DashboardTheme) {
  document.documentElement.dataset.dashboardTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
}

export async function transitionDashboardTheme(
  apply: () => void,
  origin: { x: number; y: number },
) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startViewTransition = document.startViewTransition?.bind(document);
  if (reduced || !startViewTransition) {
    apply();
    return;
  }

  const radius = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y),
  );

  const transition = startViewTransition(apply);
  await transition.ready;
  document.documentElement.animate(
    {
      clipPath: [
        `circle(0px at ${origin.x}px ${origin.y}px)`,
        `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
      ],
    },
    {
      duration: 760,
      easing: "cubic-bezier(0.45, 0, 0.2, 1)",
      pseudoElement: "::view-transition-new(root)",
    },
  );
}
