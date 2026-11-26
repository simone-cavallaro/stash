import type { StashClient } from '../../supabase.ts';

const bucket = 'stash-attachments';
export const maxFiles = 5;
const maxSize = 10 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const acceptedFiles = Object.keys(mimeByExtension).map((extension) => `.${extension}`).join(',');

export type ItemFile = {
  id: string; name: string; size: number; mime: string; object_path: string; status: 'pending' | 'ready';
};
export type Upload = { id: string; file: File; mime: string };

export function prepareFiles(files: FileList | File[], existingCount = 0): Upload[] {
  if (files.length + existingCount > maxFiles) throw new Error('Puoi aggiungere al massimo 5 allegati per nota.');
  return [...files].map((file) => {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const mime = extension && Object.hasOwn(mimeByExtension, extension) && mimeByExtension[extension];
    if (!mime) throw new Error('Scegli un’immagine, un PDF, un TXT o un documento Office supportato.');
    if (!file.size || file.size > maxSize) throw new Error('Ogni allegato deve avere una dimensione tra 1 byte e 10 MB.');
    if (file.name.length > 255 || /[\u0000-\u001f\u007f]/u.test(file.name)) throw new Error('Il nome dell’allegato non è valido.');
    return { id: crypto.randomUUID(), file, mime };
  });
}

export async function uploadFile(client: StashClient, itemId: string, upload: Upload) {
  const { id, file, mime } = upload;
  const { data: path, error } = await client.rpc('reserve_item_file', {
    p_item: itemId, p_id: id, p_name: file.name, p_mime: mime, p_size: file.size,
  });
  if (error || typeof path !== 'string') throw error ?? new Error('attachment_reservation_failed');

  // A lost response can leave the object already uploaded. Only the finalization RPC confirms it.
  const { error: uploadError } = await client.storage.from(bucket).upload(path, await file.arrayBuffer(), {
    contentType: mime, cacheControl: '0', upsert: false,
  });
  const { data: complete, error: finalizeError } = await client.rpc('complete_item_file', { p_item: itemId, p_id: id });
  if (finalizeError || !complete) throw finalizeError ?? uploadError ?? new Error('attachment_incomplete');
}

export async function downloadFile(client: StashClient, file: Pick<ItemFile, 'object_path' | 'name'>) {
  const { data, error } = await client.storage.from(bucket).download(file.object_path);
  if (error) throw error;
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function removeFile(client: StashClient, itemId: string, fileId: string) {
  const { data, error } = await client.rpc('remove_item_file', { p_item: itemId, p_id: fileId });
  if (error || !data) throw error ?? new Error('attachment_unavailable');
}
