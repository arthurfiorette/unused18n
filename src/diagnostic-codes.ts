/** Reserved outside TypeScript's built-in range so editor integrations can identify linter findings. */
export const DiagnosticCode = {
  UnusedKey: 95_001,
  UnresolvedReference: 95_002,
  RemovedKey: 95_003,
  RemovalFailure: 95_004,
  ConfigurationFailure: 95_005
} as const;
