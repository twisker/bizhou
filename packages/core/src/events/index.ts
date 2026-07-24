/**
 * 进度事件：核心库"只发事件、不 print"。CLI/前端订阅这些事件渲染进度。
 */

export type ProgressPhase = "encrypt" | "decrypt" | "upload" | "download" | "verify";

export interface ProgressEvent {
  readonly phase: ProgressPhase;
  /** 当前处理到的分片序号（从 0）。 */
  readonly seq: number;
  /** 分片总数。 */
  readonly totalChunks: number;
  /** 已处理字节数（累计，明文口径）。 */
  readonly bytesDone: number;
  /** 总字节数（明文口径）。 */
  readonly bytesTotal: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;
