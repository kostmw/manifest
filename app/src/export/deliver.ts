/** Browser-side delivery of an export. The text itself comes from the pure formatters. */

export function exportFileName(batchName: string, formatId: string, extension: string): string {
  const slug = batchName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'batch'}-${formatId}.${extension}`;
}

export function downloadText(fileName: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function canShare(): boolean {
  return typeof navigator.share === 'function';
}

/** Returns false when the person closed the share sheet without sharing. */
export async function shareText(fileName: string, text: string, mimeType: string): Promise<boolean> {
  const file = new File([text], fileName, { type: mimeType });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: fileName });
    else await navigator.share({ title: fileName, text });
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return false;
    throw error;
  }
}
