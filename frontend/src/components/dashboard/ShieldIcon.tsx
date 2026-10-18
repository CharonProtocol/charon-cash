import type { SVGProps } from "react";

export function ShieldIcon({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 43"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M0.04 2.78L0.45 22.55C0.62 30.85 8.58 38.2 20.21 41.91C31.67 37.72 39.33 30.04 39.16 21.74L38.75 1.98L0.04 2.78Z"
        fill="currentColor"
        opacity="0.35"
      />
      <path
        d="M4.38 4.67L4.71 20.48C4.85 27.2 11.04 33 20.09 35.98C29 32.63 34.95 26.58 34.82 19.86L34.49 4.04L4.38 4.67Z"
        fill="currentColor"
      />
    </svg>
  );
}
