export async function linkThenRefreshImportPreview<T>(
  link: () => Promise<boolean>,
  loadImportPreview: () => Promise<T>,
): Promise<T | null> {
  if (!(await link())) return null;
  return loadImportPreview();
}
