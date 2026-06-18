// transfer.ts
// -----------------------------------------------------------------------------
// Chunked file transfer over LiveKit's data channel.
//
// LiveKit data messages are small (~15 KB safe max per publish), so a multi-MB
// audio file must be split into chunks and reassembled on the other side.
//
// Protocol (see main.ts for the wiring):
//   1. Sender publishes a control message  { type:'file-begin', id, name, size, mime }
//   2. Sender publishes raw byte chunks on topic `smp-file:<id>`
//   3. Receiver appends chunks (LiveKit reliable data is ORDERED, so no index needed)
//      until it has `size` bytes, then assembles a Blob.
// -----------------------------------------------------------------------------

export const CHUNK_SIZE = 12 * 1024; // 12 KB — comfortably under the data-channel limit
export const FILE_TOPIC_PREFIX = 'smp-file:';

export interface FileBegin {
  id: string;
  name: string;
  size: number;
  mime: string;
}

interface Incoming extends FileBegin {
  received: number;
  parts: Uint8Array[];
}

/** Reassembles chunked files arriving over the data channel. */
export class FileReceiver {
  private files = new Map<string, Incoming>();

  begin(meta: FileBegin) {
    this.files.set(meta.id, { ...meta, received: 0, parts: [] });
  }

  /** Append a chunk. Returns the finished Blob (+meta) once all bytes have arrived. */
  push(id: string, bytes: Uint8Array): { blob: Blob; meta: FileBegin } | null {
    const f = this.files.get(id);
    if (!f) return null;
    f.parts.push(bytes);
    f.received += bytes.byteLength;
    if (f.received >= f.size) {
      this.files.delete(id);
      return { blob: new Blob(f.parts as BlobPart[], { type: f.mime || 'audio/mpeg' }), meta: f };
    }
    return null;
  }

  /** 0..1 progress for an in-flight transfer (for UI). */
  progress(id: string): number {
    const f = this.files.get(id);
    return f && f.size ? f.received / f.size : 0;
  }
}

/**
 * Slice `file` and hand each chunk to `send`. Yields to the event loop periodically
 * so we don't overflow the data channel's send buffer on big files.
 */
export async function sendFileChunks(
  file: File,
  send: (bytes: Uint8Array) => void | Promise<void>,
  onProgress?: (fraction: number) => void
) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let sent = 0;
  for (let off = 0; off < buf.byteLength; off += CHUNK_SIZE) {
    const chunk = buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.byteLength));
    await send(chunk);
    sent += chunk.byteLength;
    onProgress?.(sent / buf.byteLength);
    // Breathe every ~16 chunks (~192 KB) to let the channel drain.
    if ((off / CHUNK_SIZE) % 16 === 15) await new Promise((r) => setTimeout(r, 8));
  }
}

export function newTransferId(): string {
  return Math.random().toString(36).slice(2, 10);
}
