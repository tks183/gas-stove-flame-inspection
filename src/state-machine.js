/**
 * 融合仲裁 + 状态机。
 * 将 YOLO 的 Correct/error 检测结果与通道 A 的火焰颜色/运动分析融合，
 * 输出适合产线展示的最终状态。
 */
export class FusionStateMachine {
  constructor(config = {}) {
    this.config = config;
    this.phase = 'idle';
    this.phaseEnteredAt = Date.now();
    this.lastNormalAt = 0;
    this.lastStatus = 'unknown';
    this.lastSummary = '等待开始试火';
    this.lastReason = '';
  }

  startTest() {
    this.phase = 'ignition';
    this.phaseEnteredAt = Date.now();
    this.lastNormalAt = 0;
    this.lastStatus = 'unknown';
    this.lastSummary = '点火检测中';
    this.lastReason = '等待检测到稳定火焰';
  }

  extinguishTest() {
    this.phase = 'extinguish';
    this.phaseEnteredAt = Date.now();
    this.lastNormalAt = 0;
    this.lastStatus = 'unknown';
    this.lastSummary = '熄火检测中';
    this.lastReason = '请关闭气源，系统确认火焰是否消失';
  }

  reset() {
    this.phase = 'idle';
    this.phaseEnteredAt = Date.now();
    this.lastNormalAt = 0;
    this.lastStatus = 'unknown';
    this.lastSummary = '等待开始试火';
    this.lastReason = '';
  }

  update({ yoloBoxes = [], cv = {}, yoloLatency = 0, backend = '--' }) {
    const now = Date.now();
    const correctBoxes = yoloBoxes.filter(b => !b.isIssue);
    const errorBoxes = yoloBoxes.filter(b => b.isIssue);
    const flameActive = Number(cv.flameRatio || 0) >= Number(this.config.cv?.flameThreshold ?? 0.006);
    const motionActive = Number(cv.motionScore || 0) >= Number(this.config.cv?.motionThreshold ?? 2.5);

    let frameStatus = 'unknown';
    let summary = '未检测到有效目标';
    let reason = '';

    if (errorBoxes.length > 0) {
      frameStatus = 'issue';
      summary = '检测到异常';
      reason = `YOLO 检出 popular（可信度 ${(errorBoxes[0].confidence * 100).toFixed(1)}%）`;
    } else if (correctBoxes.length > 0) {
      frameStatus = 'normal';
      summary = '试火状态正常';
      reason = `YOLO 检出 fire（可信度 ${(correctBoxes[0].confidence * 100).toFixed(1)}%）`;
    } else if (flameActive) {
      frameStatus = 'normal';
      summary = '检测到火焰';
      reason = '颜色通道检测到火焰特征';
    } else if (motionActive) {
      frameStatus = 'unknown';
      summary = '检测到画面动态';
      reason = '颜色/运动通道有变化，但未确认火焰';
    } else {
      frameStatus = 'unknown';
      summary = '未检测到火焰';
      reason = 'YOLO 与颜色通道均未确认目标';
    }

    if (frameStatus === 'normal') this.lastNormalAt = now;

    if (this.phase === 'ignition') {
      if (frameStatus === 'normal' && now - this.phaseEnteredAt >= Number(this.config.fusion?.stableAfterMs ?? 1200)) {
        this.phase = 'stable';
        this.phaseEnteredAt = now;
        this.lastStatus = 'normal';
        this.lastSummary = '点火成功，燃烧稳定';
        this.lastReason = reason;
      } else if (frameStatus === 'issue') {
        this.phase = 'abnormal';
        this.phaseEnteredAt = now;
        this.lastStatus = 'issue';
        this.lastSummary = '点火异常';
        this.lastReason = reason;
      } else {
        this.lastStatus = 'unknown';
        this.lastSummary = '点火检测中';
        this.lastReason = reason;
      }
    } else if (this.phase === 'extinguish') {
      if (frameStatus === 'normal' && now - this.phaseEnteredAt >= Number(this.config.fusion?.extinguishGraceMs ?? 3000)) {
        this.phase = 'abnormal';
        this.phaseEnteredAt = now;
        this.lastStatus = 'issue';
        this.lastSummary = '熄火检测失败：仍有火焰';
        this.lastReason = reason;
      } else if (frameStatus !== 'normal') {
        this.phase = 'extinguished';
        this.phaseEnteredAt = now;
        this.lastStatus = 'normal';
        this.lastSummary = '熄火确认成功';
        this.lastReason = '当前画面未检测到火焰';
      } else {
        this.lastStatus = 'unknown';
        this.lastSummary = '熄火检测中';
        this.lastReason = '仍检测到火焰，等待熄灭';
      }
    } else if (this.phase === 'stable') {
      if (frameStatus === 'issue') {
        this.phase = 'abnormal';
        this.lastStatus = 'issue';
        this.lastSummary = '燃烧过程中检测到异常';
        this.lastReason = reason;
      } else {
        this.lastStatus = frameStatus === 'unknown' ? 'normal' : frameStatus;
        this.lastSummary = frameStatus === 'unknown' ? '燃烧稳定' : summary;
        this.lastReason = frameStatus === 'unknown' ? '短暂未检出，沿用稳定状态' : reason;
      }
    } else if (this.phase === 'extinguished') {
      if (frameStatus === 'normal') {
        this.phase = 'abnormal';
        this.lastStatus = 'issue';
        this.lastSummary = '熄火后重新检测到火焰';
        this.lastReason = reason;
      } else {
        this.lastStatus = 'normal';
        this.lastSummary = '熄火确认成功';
        this.lastReason = '当前画面未检测到火焰';
      }
    } else if (this.phase === 'abnormal') {
      this.lastStatus = 'issue';
      // 保留异常结论，等待人工复位
    } else {
      this.lastStatus = frameStatus;
      this.lastSummary = summary;
      this.lastReason = reason;
    }

    const phaseLabels = {
      idle: '待机',
      ignition: '点火期',
      stable: '稳定燃烧',
      extinguish: '熄火检测',
      extinguished: '已熄火',
      abnormal: '异常'
    };

    return {
      phase: this.phase,
      phaseLabel: phaseLabels[this.phase] || this.phase,
      status: this.lastStatus,
      summary: this.lastSummary,
      reason: this.lastReason,
      frameStatus,
      correctCount: correctBoxes.length,
      errorCount: errorBoxes.length,
      totalBoxes: yoloBoxes.length,
      flameRatio: Number(cv.flameRatio || 0),
      motionScore: Number(cv.motionScore || 0),
      brightRatio: Number(cv.brightRatio || 0),
      cvActive: Boolean(cv.active),
      yoloLatency: Number(yoloLatency || 0),
      backend
    };
  }
}
