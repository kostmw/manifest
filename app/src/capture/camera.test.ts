import { describe, expect, it } from 'vitest';
import { checkCameraAvailability, classifyCameraError } from './camera';

describe('classifyCameraError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no-camera'],
    ['OverconstrainedError', 'no-camera'],
    ['NotReadableError', 'in-use'],
    ['AbortError', 'in-use'],
    ['SomethingNew', 'unknown'],
  ])('maps %s to %s', (name, expected) => {
    expect(classifyCameraError(new DOMException('x', name))).toBe(expected);
  });

  it('treats values that are not errors as unknown', () => {
    expect(classifyCameraError(null)).toBe('unknown');
    expect(classifyCameraError('boom')).toBe('unknown');
  });
});

describe('checkCameraAvailability', () => {
  it('reports an insecure context first, because browsers hide mediaDevices there', () => {
    expect(checkCameraAvailability({ isSecureContext: false, hasGetUserMedia: false })).toBe('insecure');
  });

  it('reports missing getUserMedia in a secure context', () => {
    expect(checkCameraAvailability({ isSecureContext: true, hasGetUserMedia: false })).toBe('unsupported');
  });

  it('passes when the camera can be requested', () => {
    expect(checkCameraAvailability({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });
});
