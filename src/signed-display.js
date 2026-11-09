/** No silent downgrade from signed QR on presentation-only changes. */
export function selectDisplayedPayload(original, signedOriginal, signedEncoded, override=null){
  if(typeof original!=='string')throw new TypeError('Invalid QR content');
  const newSignature=typeof override==='string';
  const active=newSignature || (signedEncoded!==null && signedOriginal===original);
  return {value:active?(newSignature?override:signedEncoded):original,signed:active,
    signedOriginal:active?original:null,signedEncoded:active?(newSignature?override:signedEncoded):null,
    dropped:!active&&signedEncoded!==null};
}
