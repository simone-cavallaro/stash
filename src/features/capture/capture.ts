export const maxCaptureLength = 8000;

export type Capture = {
  id: string;
  raw_text: string;
  source_url: string | null;
  capture_source: 'manual' | 'share';
};

export function httpUrl(value: string) {
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || url.href.length > maxCaptureLength ? null : url.href;
  } catch {
    return null;
  }
}

export function makeCapture(rawText: string, source: Capture['capture_source'], sharedUrl = ''): Capture {
  if (!rawText.trim() || rawText.length > maxCaptureLength) throw new Error('invalid_capture');
  const textUrl = rawText.match(/(?:^|\s)(https?:\/\/[^\s<>\"]+)/i)?.[1] ?? '';
  return {
    id: crypto.randomUUID(),
    raw_text: rawText,
    source_url: httpUrl(sharedUrl.trim()) ?? httpUrl(textUrl),
    capture_source: source,
  };
}

export function fromShare(form: FormData) {
  const values = ['title', 'text', 'url'].map((name) => {
    const value = form.get(name);
    return typeof value === 'string' && value.trim() ? value : '';
  });
  const original = [...new Set(values.filter(Boolean))].join('\n');
  return makeCapture(original, 'share', values[2]);
}
