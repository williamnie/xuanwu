import { message as toast } from '../../store/toastStore';

export function showToastNotice(notice) {
  if (!notice?.text) return;
  const tone = notice.tone || 'info';
  if (tone === 'success') {
    toast.success(notice.text);
  } else if (tone === 'error') {
    toast.error(notice.text);
  } else if (tone === 'warning') {
    toast.warning(notice.text);
  } else {
    toast.info(notice.text);
  }
}
