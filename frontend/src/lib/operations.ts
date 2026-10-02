export const OPERATIONS = [
  "Send",
  "Withdraw",
  "Private Swap",
  "Shielded Transfer",
  "Payroll",
] as const;
export type Operation = (typeof OPERATIONS)[number];

