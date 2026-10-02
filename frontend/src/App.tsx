import { lazy, Suspense, useEffect, useState } from "react";
import { Landing } from "./pages/Landing";
import "./App.css";

const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })),
);

export default function App() {
  const [dashboard, setDashboard] = useState(
    window.location.hash === "#dashboard",
  );
  useEffect(() => {
    const navigate = () => setDashboard(window.location.hash === "#dashboard");
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  return dashboard ? (
    <Suspense
      fallback={
        <div
          style={{ minHeight: "100svh", background: "white" }}
          role="status"
          aria-label="Loading dashboard"
        />
      }
    >
      <Dashboard />
    </Suspense>
  ) : (
    <Landing />
  );
}
