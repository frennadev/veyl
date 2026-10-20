// Exact decimal-to-atom conversion, including numbers rendered in scientific notation by JavaScript.
export function amountUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals.');
  const m = String(value).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!m || !(m[2] || m[3])) throw new Error('Enter a valid amount.');
  const exponent = Number(m[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Amount is out of range.');
  const digits = BigInt((m[2] || '') + (m[3] || ''));
  const shift = decimals + exponent - (m[3] || '').length;
  const atoms = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return m[1] === '-' ? -atoms : atoms;
}
