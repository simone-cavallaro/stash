export async function matchesSecret(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [left, right] = await Promise.all([digest(provided), digest(`Bearer ${expected}`)]);
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}
