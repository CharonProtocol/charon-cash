import { m, useReducedMotion } from "motion/react";
export function StepIndicator({
  step,
  labels = ["Amount", "Recipient", "Transaction"],
}: {
  step: number;
  labels?: string[];
}) {
  const reduced = useReducedMotion();
  return (
    <ol
      className="m-0 flex list-none justify-center gap-1.5 p-0"
      aria-label={`Step ${step + 1} of ${labels.length}`}
    >
      {labels.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? "step" : undefined}
        >
          <m.span
            className="block h-3 rounded-full bg-[#303030] [@media(max-height:560px)]:h-2"
            animate={{ width: index === step ? 66 : 20 }}
            transition={{ duration: reduced ? 0 : 0.22 }}
          />
          <span className="sr-only">{label}</span>
        </li>
      ))}
    </ol>
  );
}
