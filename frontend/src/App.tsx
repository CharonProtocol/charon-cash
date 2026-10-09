import { lazy, Suspense, useEffect, useState } from "react";
import { Landing } from "./pages/Landing";
import { Waitlist } from "./pages/Waitlist";
import "./App.css";

const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })),
);

export default function App() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const navigate = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);

  if (route === "#dashboard") {
    return (
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
    );
  }

  if (route === "#waitlist") {
    return <Waitlist />;
  }

  return <Landing />;
}
