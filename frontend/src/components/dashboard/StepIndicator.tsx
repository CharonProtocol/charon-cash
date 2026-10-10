export function StepIndicator({
  step,
  labels = ["Amount", "Recipient", "Transaction"],
}: {
  step: number;
  labels?: string[];
}) {
  return (
    <ol
      className="dashboard-step"
      aria-label={`Step ${step + 1} of ${labels.length}`}
    >
      {labels.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? "step" : undefined}
        >
          <span
            className="dashboard-step-mark"
            aria-hidden="true"
          />
          <span className="sr-only">{label}</span>
        </li>
      ))}
    </ol>
  );
}
