export interface StateImportConnection {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export function stableId(prefix: string, value: unknown): string;

export function importState(
  connection: StateImportConnection,
  state: Record<string, unknown>,
  sourceName: string
): Promise<void>;

export function importAppState(options?: {
  databaseUrl?: string;
  statePath?: string;
}): Promise<string>;
