interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  readonly name?: string;
}

interface DurableObjectStub {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface SqlStorageCursor<T = Record<string, unknown>> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
  readonly rowsRead: number;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...binds: unknown[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T>;
}

interface D1Meta {
  changes: number;
  last_row_id: number;
}

interface D1Result {
  success: boolean;
  meta: D1Meta;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: { new (): WebSocketPair };

interface WebSocket {
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

interface Response {
  readonly webSocket?: WebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface AnalyticsEngineDataPoint {
  indexes?: string[];
  blobs?: (string | null)[];
  doubles?: number[];
}

interface AnalyticsEngineDataset {
  writeDataPoint(event: AnalyticsEngineDataPoint): void;
}
