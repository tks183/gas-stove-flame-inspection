/**
 * 通道 A：纯 JS 像素运算。
 * - 颜色阈值：寻找黄/橙/蓝火焰像素
 * - 帧差：计算运动突变
 * 输出火焰占比、运动分数和一个粗候选框。
 */
export class CvChannel {
  constructor(cvConfig = {}) {
    this.flameThreshold = Number(cvConfig.flameThreshold ?? 0.006);
    this.motionThreshold = Number(cvConfig.motionThreshold ?? 2.5);
    this.sampleStep = Math.max(1, Number(cvConfig.sampleStep ?? 4));
    this.prevGray = null;
    this.prevWidth = 0;
    this.prevHeight = 0;
    this.lastResult = {
      flameRatio: 0,
      motionScore: 0,
      brightRatio: 0,
      candidateBox: null,
      active: false
    };
  }

  analyze(rgb, width, height) {
    const step = this.sampleStep;
    const sampleW = Math.ceil(width / step);
    const sampleH = Math.ceil(height / step);
    const gray = new Uint8Array(sampleW * sampleH);

    let flameCount = 0;
    let brightCount = 0;
    let total = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    let si = 0;
    for (let y = 0; y < height; y += step) {
      const rowOffset = y * width * 3;
      for (let x = 0; x < width; x += step) {
        const idx = rowOffset + x * 3;
        const r = rgb[idx];
        const g = rgb[idx + 1];
        const b = rgb[idx + 2];

        gray[si++] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
        total++;

        const bright = (r + g + b) > 520;
        if (bright) brightCount++;

        // 黄/橙色火焰：红高、绿中高、蓝低
        const yellowOrange = r > 170 && g > 75 && b < 140 && r > b * 1.35 && r >= g * 0.9;
        // 偏蓝火焰：蓝高、红低、绿中高
        const blueFlame = b > 150 && g > 80 && r < 150 && b > r * 1.25;

        if (yellowOrange || blueFlame) {
          flameCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    let motionScore = 0;
    if (this.prevGray && this.prevGray.length === gray.length && this.prevWidth === width && this.prevHeight === height) {
      let diff = 0;
      for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - this.prevGray[i]);
      motionScore = diff / gray.length;
    }

    this.prevGray = gray;
    this.prevWidth = width;
    this.prevHeight = height;

    const flameRatio = total ? flameCount / total : 0;
    const candidateBox = flameCount > 0 && maxX > minX && maxY > minY
      ? {
          x: minX,
          y: minY,
          w: maxX - minX + step,
          h: maxY - minY + step
        }
      : null;

    this.lastResult = {
      flameRatio,
      motionScore,
      brightRatio: total ? brightCount / total : 0,
      candidateBox,
      active: flameRatio >= this.flameThreshold || motionScore >= this.motionThreshold
    };
    return this.lastResult;
  }

  reset() {
    this.prevGray = null;
    this.prevWidth = 0;
    this.prevHeight = 0;
    this.lastResult = {
      flameRatio: 0,
      motionScore: 0,
      brightRatio: 0,
      candidateBox: null,
      active: false
    };
  }
}
