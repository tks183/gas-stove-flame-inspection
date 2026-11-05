/**
 * 从 FFmpeg 的 MJPEG 输出中拆分完整 JPEG 帧。
 * 输入是可能被任意截断的 Buffer，输出逐个完整 JPEG Buffer。
 */
export class MjpegFrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.maxBufferSize = 12 * 1024 * 1024;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBufferSize) {
      // 防止坏流把内存吃满，保留尾部重新同步
      this.buffer = this.buffer.subarray(this.buffer.length - 1024 * 1024);
    }

    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        if (this.buffer.length > 2) this.buffer = this.buffer.subarray(this.buffer.length - 1);
        return;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);

      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) return;

      const frame = this.buffer.subarray(0, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      if (frame.length > 1024) this.onFrame(Buffer.from(frame));
    }
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}
