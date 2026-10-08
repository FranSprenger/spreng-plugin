import { readImageDimensions } from './image-dimensions.mjs';

const SHAPES = { square: '1:1', portrait: '4:5', story: '9:16', landscape: '3:2' };

export function requestedFormat(job) {
  if (Object.hasOwn(SHAPES, job.requestedSize ?? '')) return job.requestedSize;
  return null;
}

/** This one format-only sentence was approved by the owner on 2026-10-07. */
export function formatSuffix(format) {
  return Object.hasOwn(SHAPES, format ?? '')
    ? `REQUESTED FORMAT: ${format}. Verify the resulting dimensions; report a mismatch without silently regenerating.`
    : '';
}

export function formatPrompt(prompt, format) {
  const suffix = formatSuffix(format);
  // The caller can pass a prompt already recorded with the approved suffix; never duplicate it.
  return suffix && !prompt.endsWith(`\n\n${suffix}`) ? `${prompt}\n\n${suffix}` : prompt;
}

export function dimensionReceipt(bytes, format) {
  const dimensions = readImageDimensions(bytes);
  const aspectRatio = SHAPES[format] || null;
  const [w, h] = aspectRatio ? aspectRatio.split(':').map(Number) : [];
  const matches = dimensions && aspectRatio ? [w / h, ...(format === 'landscape' ? [16 / 9] : [])].some((ratio) => Math.abs(dimensions.width / dimensions.height - ratio) <= 0.015) : null;
  return {
    dimensions,
    dimensionCheck: {
      requestedSize: format,
      aspectRatio,
      status: matches === null ? 'unverified' : matches ? 'matches' : 'mismatch',
      verification: dimensions ? 'local_image_header' : 'unreadable_image_header',
      fullDecodeVerified: false,
      ...(matches === false ? { warning: `Requested ${format}; received ${dimensions.width}x${dimensions.height}. Saved without automatic regeneration.` } : {}),
    },
  };
}
