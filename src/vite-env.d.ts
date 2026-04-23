/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When set, start flow opens a WebSocket to this URL (e.g. ws://localhost:3334 or wss://rooms.example.com). */
  readonly VITE_ROOM_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
