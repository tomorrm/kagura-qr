import QRCode from 'qrcode-generator';

// Explicit Unicode encoding; QR symbols must encode UTF-8 byte sequences.
QRCode.stringToBytes = value => Array.from(new TextEncoder().encode(value));

export const MAX_CONTENT_LENGTH = 2200;
export const QUIET_ZONE = 4;

export function qrMatrix(value, level = 'H') {
  if (typeof value !== 'string' || !value.trim()) throw new Error('QRに変換する内容を入力してください。');
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_CONTENT_LENGTH) throw new Error('内容が長すぎます。2,200バイト以内にしてください。');
  const qr = QRCode(0, ['L', 'M', 'Q', 'H'].includes(level) ? level : 'H');
  qr.addData(value);
  try { qr.make(); } catch { throw new Error('この誤り訂正レベルでは内容を格納できません。短くするかレベルを下げてください。'); }
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, y) =>
    Array.from({ length: count }, (_, x) => qr.isDark(y, x)));
}

export function renderSVG(matrix, { dark = '#18191d', light = '#ffffff', margin = QUIET_ZONE } = {}) {
  if (![dark, light].every(color=>/^#[0-9a-fA-F]{6}$/.test(color)))
    throw new Error('SVGの色は6桁の16進数で指定してください。');
  if (!Number.isInteger(margin) || margin < QUIET_ZONE || margin > 32)
    throw new Error('QRの余白は4〜32モジュールで指定してください。');
  const n = matrix.length, size = n + margin * 2;
  const path = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (matrix[y][x]) path.push(`M${x + margin} ${y + margin}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path fill="${dark}" d="${path.join('')}"/></svg>`;
}

export function drawQR(canvas, matrix, { dark = '#18191d', light = '#ffffff', margin = QUIET_ZONE, pixelSize = 10 } = {}) {
  if (![dark, light].every(color=>/^#[0-9a-fA-F]{6}$/.test(color)))
    throw new Error('QRの色は6桁の16進数で指定してください。');
  if (!Number.isInteger(margin) || margin<QUIET_ZONE || margin>32 ||
      !Number.isInteger(pixelSize) || pixelSize<1 || pixelSize>100)
    throw new Error('QRの描画設定が不正です。');
  const count = matrix.length + margin * 2;
  canvas.width = canvas.height = count * pixelSize;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvasを利用できません');
  ctx.fillStyle = light; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = dark;
  matrix.forEach((row, y) => row.forEach((active, x) => {
    if (active) ctx.fillRect((x + margin) * pixelSize, (y + margin) * pixelSize, pixelSize, pixelSize);
  }));
  return canvas;
}

export function wifiPayload({ssid, password, auth = 'WPA', hidden = false}) {
  if (!ssid) throw new Error('Wi-Fi名を入力してください。');
  const escape = s => String(s).replace(/([\\;,:"\\])/g, '\\$1');
  return `WIFI:T:${auth};S:${escape(ssid)};P:${escape(password || '')};H:${hidden ? 'true' : 'false'};;`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2500);
}
