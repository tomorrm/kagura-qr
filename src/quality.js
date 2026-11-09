/** Heuristic pre-print checks, NOT ISO/IEC 15415 grading or field certification. */
export function relativeLuminance(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('色は#RRGGBB形式で指定してください。');
  const channel = i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground), b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function inspectQRPrint(matrix, {foreground='#17191f', background='#ffffff', quietZone=4, widthMm=40, dpi=300}={}) {
  if (!Array.isArray(matrix) || !matrix.length || matrix.length > 177 ||
      matrix.some(row => !Array.isArray(row) || row.length !== matrix.length || row.some(x=>typeof x !== 'boolean')))
    throw new Error('QR行列が不正です。');
  if (![foreground,background].every(c=>/^#[0-9a-f]{6}$/i.test(c))) throw new Error('指定色が不正です。');
  if (!Number.isFinite(widthMm) || widthMm < 5 || widthMm > 1000 ||
      !Number.isFinite(dpi) || dpi < 50 || dpi > 2400) throw new Error('印刷条件が不正です。');
  const ratio=contrastRatio(foreground,background);
  const modules=matrix.length + 2 * quietZone;
  const moduleMm=widthMm/modules;
  const pixelsPerModule=widthMm / 25.4 * dpi / modules;
  const issues=[];
  if (quietZone < 4) issues.push('周囲の余白が不足しています（推奨4モジュール）。');
  if (relativeLuminance(foreground) >= relativeLuminance(background)) issues.push('背景よりQR模様が明るく、通常の読取機で失敗する可能性があります。');
  if (ratio < 4.5) issues.push('コントラストが低く、読取環境によって失敗する可能性があります。');
  if (pixelsPerModule < 4) issues.push('指定した印刷サイズ・解像度では1モジュールの画素数が少なめです。');
  if (moduleMm < 0.25) issues.push('1モジュールが小さく、印刷精度や撮影距離に注意が必要です。');
  return {ratio:Number(ratio.toFixed(2)), modules, moduleMm:Number(moduleMm.toFixed(3)),
    pixelsPerModule:Number(pixelsPerModule.toFixed(2)), status:issues.length?'caution':'pass',issues,
    disclaimer:'ブラウザによる事前チェックです。ISO/IEC 15415等に基づく検証・読み取り保証ではありません。'};
}
