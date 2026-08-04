export function imageFilesFromTransfer(dataTransfer) {
  const files = promptEditorImageFiles(dataTransfer?.files);
  if (files.length > 0) return files;

  return Array.from(dataTransfer?.items || []).flatMap((item) => {
    if (item?.kind !== 'file') return [];
    const file = item.getAsFile?.();
    return isPromptEditorImageFile(file) ? [file] : [];
  });
}

export function promptEditorImageFiles(files) {
  return Array.from(files || []).filter(isPromptEditorImageFile);
}

export function handlePromptEditorImageTransfer(dataTransfer, uploadFiles) {
  const images = imageFilesFromTransfer(dataTransfer);
  if (images.length === 0) return false;
  uploadFiles(images);
  return true;
}

export function isPromptEditorImageFile(file) {
  if (!file) return false;
  return isImageMime(file.type) || /\.(?:png|jpe?g|gif|webp)$/i.test(String(file.name || ''));
}

function isImageMime(type) {
  return String(type || '').startsWith('image/');
}
