export const ALLOWED_UPLOADS: Record<string, string[]> = {
  "application/pdf": ["pdf"], "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
  "text/csv": ["csv"], "image/svg+xml": [], // SVG is deliberately refused: it can carry script
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function checkUpload(file: { name: string; type: string; size: number }): string | null {
  const exts = ALLOWED_UPLOADS[file.type];
  if (!exts || exts.length === 0) return "This file type is not allowed.";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!exts.includes(ext)) return "The file extension does not match its type.";
  if (file.size <= 0) return "The file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "The file is larger than 10 MB.";
  return null;
}
