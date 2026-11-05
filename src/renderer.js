import sharp from 'sharp';

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, ch => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[ch]));
}

/**
 * 用 sharp + SVG 合成检测画面。
 * 比 @napi-rs/canvas 逐帧绘制 + JPEG 编码更快，适合高帧率推流。
 */
export async function renderFrame(jpegBuffer, { yoloBoxes = [], cv = {}, metrics = {}, output = {} }) {
  const meta = await sharp(jpegBuffer).metadata();
  const imageWidth = meta.width;
  const imageHeight = meta.height;
  const outWidth = Math.max(320, Number(output.width) || imageWidth);
  const outHeight = Math.max(180, Number(output.height) || Math.round(outWidth * imageHeight / imageWidth));
  const quality = Math.max(40, Math.min(95, Number(output.quality) || 62));

  const bx = outWidth / imageWidth;
  const by = outHeight / imageHeight;
  const scale = Math.max(1, outWidth / 1280);
  const lineWidth = Math.max(2, Math.round(3 * scale));
  const fontSize = Math.max(13, Math.round(18 * scale));
  const parts = [];

  // 通道 A 候选框
  if (cv.candidateBox && cv.active) {
    const b = cv.candidateBox;
    parts.push(`<rect x="${(b.x * bx).toFixed(1)}" y="${(b.y * by).toFixed(1)}" width="${(b.w * bx).toFixed(1)}" height="${(b.h * by).toFixed(1)}" fill="none" stroke="#ffb347" stroke-width="2" stroke-dasharray="10 7"/>`);
    parts.push(`<text x="${(b.x * bx + 6).toFixed(1)}" y="${Math.max(fontSize, b.y * by - 8).toFixed(1)}" fill="#ffb347" font-size="${fontSize}" font-family="Microsoft YaHei, sans-serif" font-weight="600">CV 火焰候选</text>`);
  }

  // YOLO 框
  for (const box of yoloBoxes) {
    const color = box.isIssue ? '#ff4d5e' : '#24d18b';
    const x = box.x * bx;
    const y = box.y * by;
    const w = box.w * bx;
    const h = box.h * by;
    const label = escapeXml(`${box.label} ${(box.confidence * 100).toFixed(1)}%`);
    const textWidth = label.length * fontSize * 0.62 + 14;
    const labelHeight = fontSize + 10;
    const labelY = Math.max(0, y - labelHeight);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${lineWidth}"/>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" width="${textWidth.toFixed(1)}" height="${labelHeight}" fill="${color}"/>`);
    parts.push(`<text x="${(x + 7).toFixed(1)}" y="${(labelY + fontSize + 1).toFixed(1)}" fill="#07100b" font-size="${fontSize}" font-family="Microsoft YaHei, sans-serif" font-weight="700">${label}</text>`);
  }

  // HUD
  const statusColor = metrics.status === 'issue' ? '#ff4d5e' : metrics.status === 'normal' ? '#24d18b' : '#ffb347';
  const hudW = Math.min(outWidth - 24 * scale, 620 * scale);
  const hudH = 118 * scale;
  const x = 12 * scale;
  const y = 12 * scale;
  const title = escapeXml(metrics.summary || '等待检测');
  const line1 = escapeXml(`阶段: ${metrics.phaseLabel || '--'}    YOLO: ${metrics.correctCount || 0} Correct / ${metrics.errorCount || 0} error`);
  const line2 = escapeXml(`火焰占比: ${((metrics.flameRatio || 0) * 100).toFixed(2)}%    运动: ${(metrics.motionScore || 0).toFixed(1)}    推理: ${(metrics.yoloLatency || 0).toFixed(0)}ms`);
  const line3 = escapeXml(`后端: ${metrics.backend || '--'}    处理: ${(metrics.processLatency || 0).toFixed(0)}ms`);

  parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${hudW.toFixed(1)}" height="${hudH.toFixed(1)}" fill="rgba(7,11,16,0.78)" stroke="rgba(255,255,255,0.16)" stroke-width="1"/>`);
  parts.push(`<text x="${(x + 14 * scale).toFixed(1)}" y="${(y + 34 * scale).toFixed(1)}" fill="${statusColor}" font-size="${Math.round(24 * scale)}" font-family="Microsoft YaHei, sans-serif" font-weight="800">${title}</text>`);
  parts.push(`<text x="${(x + 14 * scale).toFixed(1)}" y="${(y + 62 * scale).toFixed(1)}" fill="#dfe7f2" font-size="${Math.round(15 * scale)}" font-family="Microsoft YaHei, sans-serif">${line1}</text>`);
  parts.push(`<text x="${(x + 14 * scale).toFixed(1)}" y="${(y + 88 * scale).toFixed(1)}" fill="#9aa6b5" font-size="${Math.round(15 * scale)}" font-family="Microsoft YaHei, sans-serif">${line2}</text>`);
  parts.push(`<text x="${(x + 14 * scale).toFixed(1)}" y="${(y + 112 * scale).toFixed(1)}" fill="#9aa6b5" font-size="${Math.round(15 * scale)}" font-family="Microsoft YaHei, sans-serif">${line3}</text>`);

  const svg = Buffer.from(`<svg width="${outWidth}" height="${outHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`);

  return sharp(jpegBuffer)
    .rotate()
    .resize(outWidth, outHeight, { fit: 'fill' })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality, chromaSubsampling: '4:2:0' })
    .toBuffer();
}
