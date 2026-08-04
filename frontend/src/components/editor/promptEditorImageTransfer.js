export function imageFilesFromTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(isImageFile);
  if (files.length > 0) return files;

  return Array.from(dataTransfer?.items || []).flatMap((item) => {
    if (item?.kind !== 'file' || !isImageMime(item.type)) return [];
    const file = item.getAsFile?.();
    return file ? [file] : [];
  });
}

export function handlePromptEditorImageTransfer(dataTransfer, uploadFiles) {
  const images = imageFilesFromTransfer(dataTransfer);
  if (images.length === 0) return false;
  uploadFiles(images);
  return true;
}

function isImageFile(file) {
  return isImageMime(file?.type);
}

function isImageMime(type) {
  return String(type || '').startsWith('image/');
}
