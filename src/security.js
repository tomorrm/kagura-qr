export function inspectContent(value) {
  if (!value) return { kind: 'empty', label: '未検出', caution: '' };
  const trimmed = value.trim();
  // Directionality and zero-width controls can spoof the visible address.
  const invisibleControls = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]/u.test(trimmed);
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(trimmed)?.[0]?.toLowerCase() || '';
  if (['javascript:', 'data:', 'vbscript:', 'file:'].includes(scheme)) {
    return {kind:'blocked',label:'危険な形式',caution:'自動で開けない形式です。リンクを開かず内容を確認してください。'};
  }
  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const url = new URL(trimmed);
      if (invisibleControls) return {kind:'caution',label:'不可視文字を含むURL',caution:'不可視文字や文字方向制御文字が含まれています。リンク先を慎重に確認してください。'};
      if (url.username || url.password) return {kind:'caution',label:'認証情報を含むURL',caution:'URLにユーザー名またはパスワードが含まれています。'};
      if (url.protocol === 'http:') return {kind:'caution',label:'暗号化されていないURL',caution:'暗号化されていないHTTP接続です。'};
      if (url.hostname.includes('xn--')) return {kind:'caution',label:'国際化ドメイン',caution:'表示と異なる文字列の可能性があります。'};
      return {kind:'url',label:'HTTPS URL',caution:'リンク先の安全性を保証するものではありません。',url:url.href};
    } catch { return {kind:'text',label:'テキスト',caution:''}; }
  }
  if (invisibleControls) return {kind:'caution',label:'不可視文字を含む内容',caution:'不可視文字や文字方向制御文字が含まれています。'};
  if (scheme) return {kind:'caution',label:'特殊なリンク形式',caution:'アプリを呼び出す形式です。内容を確認してください。'};
  return {kind:'text',label:'テキスト',caution:''};
}
